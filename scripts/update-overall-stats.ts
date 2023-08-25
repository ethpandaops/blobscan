import { BlockNumberRange, prisma } from "@blobscan/db";

const BEACON_NODE_ENDPOINT = process.env.BEACON_NODE_ENDPOINT;

if (!BEACON_NODE_ENDPOINT) {
  throw new Error("BEACON_NODE_ENDPOINT is not set");
}

type BeaconFinalizedBlockResponse = {
  data: {
    message: {
      slot: string;
      body: {
        execution_payload: {
          block_number: string;
        };
      };
    };
  };
};

type Block = {
  number: number;
  slot: number;
};

const UNPROCESSED_BLOCKS_BATCH_SIZE = 1_000_000;

async function getBlockFromBeacon(id: number | "finalized"): Promise<Block> {
  let response: Response;

  try {
    response = await fetch(
      `${BEACON_NODE_ENDPOINT}/eth/v2/beacon/blocks/${id}`
    );
  } catch (err) {
    const err_ = err as Error;

    throw new Error(
      `Failed to fetch block from beacon node: ${err_.cause ?? err_.message}`,
      {
        cause: err_.cause,
      }
    );
  }

  const {
    data: { message },
  } = (await response.json()) as BeaconFinalizedBlockResponse;

  return {
    number: Number(message.body.execution_payload.block_number),
    slot: Number(message.slot),
  };
}

async function main() {
  const [syncState, latestIndexedBlock] = await Promise.all([
    prisma.blockchainSyncState.findFirst({
      select: {
        lastFinalizedBlock: true,
      },
    }),
    prisma.block.findLatest(),
  ]);
  const lastFinalizedBlock = syncState?.lastFinalizedBlock ?? 0;

  // If we haven't indexed any blocks yet, don't do anything
  if (!latestIndexedBlock) {
    return;
  }

  const { number: currFinalizedBlock } = await getBlockFromBeacon("finalized");

  // Process only finalized blocks that were indexed
  const availableFinalizedBlock = Math.min(
    latestIndexedBlock.number,
    currFinalizedBlock
  );

  if (lastFinalizedBlock >= availableFinalizedBlock) {
    return;
  }

  const unprocessedBlocks = availableFinalizedBlock - lastFinalizedBlock + 1;
  const batches = Math.ceil(unprocessedBlocks / UNPROCESSED_BLOCKS_BATCH_SIZE);

  for (let i = 0; i < batches; i++) {
    const from = lastFinalizedBlock + i * UNPROCESSED_BLOCKS_BATCH_SIZE;
    const to = Math.min(
      from + UNPROCESSED_BLOCKS_BATCH_SIZE - 1,
      availableFinalizedBlock
    );
    const blockRange: BlockNumberRange = { from, to };

    await prisma.$transaction([
      prisma.blockOverallStats.increment(blockRange),
      prisma.transactionOverallStats.increment(blockRange),
      prisma.blobOverallStats.increment(blockRange),
      prisma.blockchainSyncState.upsert({
        create: {
          lastSlot: 0,
          lastFinalizedBlock: to,
        },
        update: {
          lastFinalizedBlock: to,
        },
        where: {
          id: 1,
        },
      }),
    ]);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
