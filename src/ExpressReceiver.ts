import { EventEmitter } from 'events';
import { Receiver, ReceiverEvent, ReceiverAckTimeoutError } from './types';
import { createServer, Server } from 'http';
import express, { Request, Response, Application, RequestHandler, NextFunction } from 'express';
import axios from 'axios';
import rawBody from 'raw-body';
import crypto from 'crypto';
import tsscmp from 'tsscmp';
import querystring from 'querystring';
import { ErrorCode, errorWithCode } from './errors';

// TODO: we throw away the key names for endpoints, so maybe we should use this interface. is it better for migrations?
// if that's the reason, let's document that with a comment.
export interface ExpressReceiverOptions {
  signingSecret: string;
  endpoints?: string | {
    [endpointType: string]: string;
  };
}

/**
 * Receives HTTP requests with Events, Slash Commands, and Actions
 */
export default class ExpressReceiver extends EventEmitter implements Receiver {

  /* Express app */
  public app: Application;

  private server: Server;

  constructor ({
    signingSecret = '',
    endpoints = { events: '/slack/events' },
  }: ExpressReceiverOptions) {
    super();

    this.app = express();
    this.app.use(this.errorHandler.bind(this));
    // TODO: what about starting an https server instead of http? what about other options to create the server?
    this.server = createServer(this.app);

    const expressMiddleware: RequestHandler[] = [
      verifySlackRequest(signingSecret),
      parseBody,
      respondToSslCheck,
      respondToUrlVerification,
      this.requestHandler.bind(this),
    ];

    const endpointList: string[] = typeof endpoints === 'string' ? [endpoints] : Object.values(endpoints);
    for (const endpoint of endpointList) {
      this.app.post(endpoint, ...expressMiddleware);
    }
  }

  private requestHandler(req: Request, res: Response): void {
    let timer: NodeJS.Timer | undefined = setTimeout(
      () => {
        this.emit('error', receiverAckTimeoutError(
          'An incoming event was not acknowledged before the timeout. ' +
          'Ensure that the ack() argument is called in your listeners.',
        ));
        timer = undefined;
      },
      2800,
    );
    const event: ReceiverEvent = {
      body: req.body as { [key: string]: any },
      ack: (response: any): void => {
        // TODO: if app tries acknowledging more than once, emit a warning
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;

          if (!response) res.send('');
          if (typeof response === 'string') {
            res.send(response);
          } else {
            res.json(response);
          }
        }
      },
      respond: undefined,
    };

    if (req.body && req.body.response_url) {
      event.respond = (response): void => {
        axios.post(req.body.response_url, response)
          .catch((e) => {
            this.emit('error', e);
          });
      };
    }

    this.emit('message', event);
  }

  // TODO: the arguments should be defined as the arguments of Server#listen()
  // TODO: the return value should be defined as a type that both http and https servers inherit from, or a union
  public start(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      try {
        // TODO: what about other listener options?
        // TODO: what about asynchronous errors? should we attach a handler for this.server.on('error', ...)?
        // if so, how can we check for only errors related to listening, as opposed to later errors?
        this.server.listen(port, () => {
          resolve(this.server);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // TODO: the arguments should be defined as the arguments to close() (which happen to be none), but for sake of
  // generic types
  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // TODO: what about synchronous errors?
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private errorHandler(err: any, _req: Request, _res: Response, next: NextFunction): void {
    this.emit('error', err);
    // Forward to express' default error handler (which knows how to print stack traces in development)
    next(err);
  }
}

const respondToSslCheck: RequestHandler = (req, res, next) => {
  if (req.body && req.body.ssl_check) {
    res.send();
    return;
  }
  next();
};

const respondToUrlVerification: RequestHandler = (req, res, next) => {
  if (req.body && req.body.type && req.body.type === 'url_verification') {
    res.json({ challenge: req.body.challenge });
    return;
  }
  next();
};

// TODO: this should be imported from another package
function verifySlackRequest(signingSecret: string): RequestHandler {
  return async (req , _res, next) => {
    try {
      const body: string = (await rawBody(req)).toString();
      const signature = req.headers['x-slack-signature'] as string;
      const ts = Number(req.headers['x-slack-request-timestamp']);

      // Divide current date to match Slack ts format
      // Subtract 5 minutes from current time
      const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);

      if (ts < fiveMinutesAgo) {
        const error = errorWithCode(
          'Slack request signing verification failed. Timestamp is too old.',
          ErrorCode.ExpressReceiverAuthenticityError,
        );
        next(error);
      }

      const hmac = crypto.createHmac('sha256', signingSecret);
      const [version, hash] = signature.split('=');
      hmac.update(`${version}:${ts}:${body}`);

      if (!tsscmp(hash, hmac.digest('hex'))) {
        const error = errorWithCode(
          'Slack request signing verification failed. Signature mismatch.',
          ErrorCode.ExpressReceiverAuthenticityError,
        );
        next(error);
      }

      // Verification passed, assign string body back to request and resume
      req.body = body;
      next();
    } catch (error) {
      next(error);
    }
  };
}

const parseBody: RequestHandler = (req, _res, next) => {
  if (req.headers['content-type'] === 'application/x-www-form-urlencoded') {
    const parsedBody = querystring.parse(req.body);
    req.body = (typeof parsedBody.payload === 'string') ? JSON.parse(parsedBody.payload) : parsedBody;
  } else {
    // TODO: should we check the content type header to make sure its JSON here?
    req.body = JSON.parse(req.body);
  }
  next();
};

function receiverAckTimeoutError(message: string): ReceiverAckTimeoutError {
  const error = new Error(message);
  (error as ReceiverAckTimeoutError).code = ErrorCode.ReceiverAckTimeoutError;
  return (error as ReceiverAckTimeoutError);
}
