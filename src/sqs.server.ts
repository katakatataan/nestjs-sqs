import { Injectable } from "@nestjs/common";
import { CustomTransportStrategy, IncomingRequest, Server } from "@nestjs/microservices";
import { Consumer, SQSMessage } from "sqs-consumer";
import { Producer } from "sqs-producer";
import { from } from "rxjs";

import { ISqsServerOptions } from "./interfaces";
import { SqsSerializer } from "./sqs.serializer";
import { SqsDeserializer } from "./sqs.deserializer";

@Injectable()
export class SqsServer extends Server implements CustomTransportStrategy {
  private consumers: Consumer[];
  private producer: Producer;

  constructor(protected readonly options: ISqsServerOptions["options"]) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public listen(callback: (error?: Error, info?: unknown[]) => void): void {
    const { producerUrl, ...options } = this.options;

    const handlers: Promise<Consumer>[] = [];

    for (const subscriptionName of this.messageHandlers.keys()) {
      handlers.push(
        new Promise(async (resolve) => {
          const consumer = Consumer.create({
            ...options,
            queueUrl: subscriptionName,
            handleMessage: await this.handleMessage(subscriptionName),
          });

          consumer.on("error", err => {
            this.logger.error(err.message);
          });

          consumer.on("processing_error", err => {
            this.logger.error(err.message);
          });

          consumer.on("timeout_error", err => {
            this.logger.error(err.message);
          });

          consumer.start();
          return resolve(consumer);
        }),
      );
    }

    Promise.all(handlers)
      .then((consumers: Consumer[]): void => {
        this.consumers = consumers;
        callback(undefined, consumers);
      })
      .catch((err: Error): void => {
        callback(err);
      });

    this.producer = Producer.create({
      ...options,
      queueUrl: producerUrl,
    });
    callback();
  }

  public async handleQueue(queue: string): Promise<void> {
    return Promise.resolve();
  }

  public handleMessage(queueUrl: string): (message: SQSMessage) => Promise<void> {
    return async (message: SQSMessage): Promise<void> => {
      const data = (await this.deserializer.deserialize(message)) as IncomingRequest;

      const handler = this.getHandlerByPattern(queueUrl);

      if (!handler) {
        return;
      }

      await handler(data)
      return Promise.resolve();
    };
  }

  public close(): void {
    for (const consumer of this.consumers) {
      consumer.stop();
    }
  }

  protected initializeSerializer(options: ISqsServerOptions["options"]): void {
    this.serializer = options?.serializer ?? new SqsSerializer();
  }

  protected initializeDeserializer(options: ISqsServerOptions["options"]): void {
    this.deserializer = options?.deserializer ?? new SqsDeserializer();
  }
}
