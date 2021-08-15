import { Test, TestingModule } from "@nestjs/testing";
import { Injectable } from "@nestjs/common";
import { Credentials, SQS } from "aws-sdk";
import waitForExpect from "wait-for-expect";

import { SqsConsumerEventHandler, SqsMessageHandler, SqsModule, SqsService } from "../src";
import { SqsConsumerEvent, SqsConsumerOptions, SqsProducerOptions } from "./interfaces";

const SQS_ENDPOINT = process.env.SQS_ENDPOINT || "http://localhost:9324";

enum TestQueue {
  Test = "test",
  DLQ = "test-dead",
}

const sqs = new SQS({
  apiVersion: "2012-11-05",
  credentials: new Credentials("x", "x"),
  region: "none",
});

const TestQueues: { [key in TestQueue]: SqsConsumerOptions | SqsProducerOptions } = {
  [TestQueue.Test]: {
    name: TestQueue.Test,
    queueUrl: `${SQS_ENDPOINT}/queue/test.fifo`,
    sqs,
  },
  [TestQueue.DLQ]: {
    name: TestQueue.DLQ,
    queueUrl: `${SQS_ENDPOINT}/queue/test-dead.fifo`,
    sqs,
  },
};

describe("SqsModule", () => {
  let module: TestingModule;

  describe("forRoot", () => {
    afterAll(async () => {
      await module?.close();
    });

    it("should register module", async () => {
      module = await Test.createTestingModule({
        imports: [
          SqsModule.forRoot(SqsModule, {
            consumers: [TestQueues[TestQueue.Test]],
            producers: [TestQueues[TestQueue.Test]],
          }),
        ],
      }).compile();

      const sqsService = module.get(SqsService);
      expect(sqsService).toBeTruthy();
      expect(sqsService.options.consumers).toHaveLength(1);
      expect(sqsService.options.producers).toHaveLength(1);
    });
  });

  describe("forRootAsync", () => {
    afterAll(async () => {
      await module?.close();
    });

    it("should register module async", async () => {
      module = await Test.createTestingModule({
        imports: [
          SqsModule.forRootAsync(SqsModule, {
            useFactory: () => {
              return {
                consumers: [TestQueues[TestQueue.Test]],
                producers: [TestQueues[TestQueue.Test]],
              };
            },
          }),
        ],
      }).compile();

      const sqsService = module.get(SqsService);
      expect(sqsService).toBeTruthy();
      expect(sqsService.options.consumers).toHaveLength(1);
      expect(sqsService.options.producers).toHaveLength(1);
    });
  });

  describe("full flow", () => {
    const fakeProcessor = jest.fn();
    const fakeDLQProcessor = jest.fn();
    const fakeErrorEventHandler = jest.fn();

    @Injectable()
    class A {
      public constructor(public readonly sqsService: SqsService) {}

      @SqsMessageHandler(TestQueue.Test)
      public handleTestMessage(message: SQS.Message) {
        fakeProcessor(message);
      }

      @SqsConsumerEventHandler(TestQueue.Test, SqsConsumerEvent.PROCESSING_ERROR)
      public handleErrorEvent(err: Error, message: SQS.Message) {
        fakeErrorEventHandler(err, message);
      }

      @SqsMessageHandler(TestQueue.DLQ)
      public handleDLQMessage(message: SQS.Message) {
        fakeDLQProcessor(message);
      }
    }

    beforeAll(async () => {
      module = await Test.createTestingModule({
        imports: [
          SqsModule.forRoot(SqsModule, {
            consumers: [
              {
                ...TestQueues[TestQueue.Test],
                waitTimeSeconds: 1,
                batchSize: 3,
                terminateVisibilityTimeout: true,
                messageAttributeNames: ["All"],
              },
              {
                ...TestQueues[TestQueue.DLQ],
                waitTimeSeconds: 1,
              },
            ],
            producers: [
              {
                ...TestQueues[TestQueue.Test],
              },
            ],
          }),
        ],
        providers: [A],
      }).compile();
      await module.init();

      const sqsService = module.get(SqsService);
      await Promise.all(Object.values(TestQueue).map(queueName => sqsService.purgeQueue(queueName)));
    });

    afterEach(() => {
      fakeProcessor.mockRestore();
      fakeErrorEventHandler.mockRestore();
    });

    afterAll(async () => {
      fakeDLQProcessor.mockReset();
      await module.close();
    });

    it("should register message handler", () => {
      const sqsService = module.get(SqsService);
      expect(sqsService.consumers.has(TestQueue.Test)).toBe(true);
    });

    it("should register message producer", () => {
      const sqsService = module.get(SqsService);
      expect(sqsService.producers.has(TestQueue.Test)).toBe(true);
    });

    it("should call message handler when a new message has come", async done => {
      jest.setTimeout(30000);

      const sqsService = module.get(SqsService);
      const id = String(Math.floor(Math.random() * 1000000));
      fakeProcessor.mockImplementationOnce(message => {
        expect(message).toBeTruthy();
        expect(JSON.parse(message.Body)).toStrictEqual({ test: true });
        done();
      });

      await sqsService.send(TestQueue.Test, {
        id,
        body: { test: true },
        delaySeconds: 0,
        groupId: "test",
        deduplicationId: id,
      });
    });

    it("should call message handler multiple times when multiple messages have come", async () => {
      jest.setTimeout(5000);

      const sqsService = module.get(SqsService);
      const groupId = String(Math.floor(Math.random() * 1000000));

      for (let i = 0; i < 3; i++) {
        const id = `${groupId}_${i}`;
        await sqsService.send(TestQueue.Test, {
          id,
          body: { test: true, i },
          delaySeconds: 0,
          groupId,
          deduplicationId: id,
        });
      }

      await waitForExpect(
        () => {
          expect(fakeProcessor.mock.calls).toHaveLength(3);
          for (const call of fakeProcessor.mock.calls) {
            expect(call).toHaveLength(1);
            expect(call[0]).toBeTruthy();
          }
        },
        5000,
        100,
      );
    });

    it("should call the registered error handler when an error occurs", async done => {
      jest.setTimeout(10000);

      const sqsService = module.get(SqsService);
      const id = String(Math.floor(Math.random() * 1000000));
      fakeProcessor.mockImplementationOnce(_message => {
        throw new Error("test");
      });
      fakeErrorEventHandler.mockImplementationOnce((error, _message) => {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain("test");
        done();
      });

      await sqsService.send(TestQueue.Test, {
        id,
        body: { test: true },
        delaySeconds: 0,
        groupId: "test",
        deduplicationId: id,
      });
    });

    it("should consume a dead letter from DLQ", async () => {
      jest.setTimeout(10000);

      await waitForExpect(
        () => {
          expect(fakeDLQProcessor.mock.calls.length).toBe(1);
        },
        9900,
        500,
      );
    });
  });
});
