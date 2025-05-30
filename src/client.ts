import { MongoClient } from "mongodb";
import {
  DatabaseAdapter,
  RAGKnowledgeItem,
  IDatabaseCacheAdapter,
  Account,
  Actor,
  GoalStatus,
  Participant,
  type Goal,
  type Memory,
  type Relationship,
  type UUID,
  elizaLogger,
  type Adapter,
  type IAgentRuntime,
} from "@elizaos/core";
import { v4 } from "uuid";
import { removeStopwords, eng } from "stopword";

interface KnowledgeDocument {
  id: UUID;
  agentId: UUID;
  content:
    | string
    | {
        text: string;
        metadata?: {
          isShared?: boolean;
          isMain?: boolean;
          isChunk?: boolean;
          originalId?: string;
          chunkIndex?: number;
        };
      };
  embedding: number[] | null;
  createdAt: Date | number;
  isMain: boolean;
  originalId: string | null;
  chunkIndex: number | null;
  isShared: boolean;
}

export class MongoDBDatabaseAdapter
  extends DatabaseAdapter<MongoClient>
  implements IDatabaseCacheAdapter
{
  private database: any;
  private databaseName: string;
  private hasVectorSearch: boolean;
  private isConnected: boolean = false;
  private isVectorSearchIndexComputable: boolean;
  public db: MongoClient;

  constructor(client: MongoClient, databaseName: string) {
    super();
    this.db = client;
    this.databaseName = databaseName;
    this.hasVectorSearch = false;
    this.isConnected = false;
    this.isVectorSearchIndexComputable = true;
  }

  private async initializeCollections(): Promise<void> {
    const collections = [
      "memories",
      "participants",
      "cache",
      "knowledge",
      "rooms",
      "accounts",
      "goals",
      "logs",
      "relationships",
    ];

    for (const collectionName of collections) {
      try {
        await this.database.createCollection(collectionName);
        console.log(`Collection ${collectionName} created or already exists`);
      } catch (error) {
        if ((error as any).code !== 48) {
          // 48 is "collection already exists"
          console.error(`Error creating collection ${collectionName}:`, error);
        }
      }
    }
  }

  private async initializeStandardIndexes(): Promise<void> {
    const collectionsWithIndexes = [
      {
        collectionName: "memories",
        indexes: [
          { key: { type: 1, roomId: 1, agentId: 1, createdAt: -1 } },
          { key: { content: "text" }, options: { weights: { content: 10 } } },
        ],
      },
      {
        collectionName: "participants",
        indexes: [{ key: { userId: 1, roomId: 1 }, options: { unique: true } }],
      },
      {
        collectionName: "cache",
        indexes: [
          { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
        ],
      },
      {
        collectionName: "knowledge",
        indexes: [
          { key: { agentId: 1 } },
          { key: { isShared: 1 } },
          { key: { id: 1 }, options: { unique: true } },
          { key: { "content.text": "text" } },
        ],
      },
    ];

    await Promise.all(
      collectionsWithIndexes.map(async ({ collectionName, indexes }) => {
        const collection = this.database.collection(collectionName);
        const existingIndexes = await collection.listIndexes().toArray();

        for (const index of indexes) {
          const indexExists = existingIndexes.some(
            (existingIndex) =>
              JSON.stringify(existingIndex.key) === JSON.stringify(index.key),
          );

          if (!indexExists) {
            console.log(`Creating index for ${collectionName}:`, index.key);
            await collection.createIndex(index.key, index.options || {});
          } else {
            console.log(
              `Index already exists for ${collectionName}:`,
              index.key,
            );
          }
        }
      }),
    );
  }

  private async initializeVectorSearch(): Promise<void> {
    try {
      // Check if vector search is supported
      const dbStatus = await this.database.admin().serverStatus();
      const vectorSearchSupported = dbStatus.vectorSearch?.supported === true;

      if (vectorSearchSupported && this.isVectorSearchIndexComputable) {
        const vectorSearchConfig = {
          name: "vector_index",
          definition: {
            vectorSearchConfig: {
              dimensions: 1536,
              similarity: "cosine",
              numLists: 100,
              efConstruction: 128,
            },
          },
        };

        try {
          // Create vector search indexes for both collections
          for (const collection of ["memories", "knowledge"]) {
            await this.database
              .collection(collection)
              .createIndex({ embedding: "vectorSearch" }, vectorSearchConfig);
          }

          this.hasVectorSearch = true;
          console.log("Vector search capabilities are available and enabled");

          // Check sharding status
          const dbInfo = await this.database
            .admin()
            .command({ listDatabases: 1, nameOnly: true });
          const memoriesStats = await this.database
            .collection("memories")
            .stats();

          if (dbInfo?.sharded && memoriesStats?.sharded) {
            this.isVectorSearchIndexComputable = false;
            this.hasVectorSearch = false;
            await this.createStandardEmbeddingIndexes();
          }
        } catch (error) {
          console.log(
            "Vector search initialization failed, falling back to standard search",
            error,
          );
          this.isVectorSearchIndexComputable = false;
          this.hasVectorSearch = false;
          await this.createStandardEmbeddingIndexes();
        }
      } else {
        console.log("Vector search not supported, using standard search");
        this.isVectorSearchIndexComputable = false;
        this.hasVectorSearch = false;
        await this.createStandardEmbeddingIndexes();
      }
    } catch (error) {
      console.log(
        "Error checking vector search capability, defaulting to standard search",
        error,
      );
      this.isVectorSearchIndexComputable = false;
      this.hasVectorSearch = false;
      await this.createStandardEmbeddingIndexes();
    }
  }

  private async createStandardEmbeddingIndexes(): Promise<void> {
    try {
      for (const collection of ["memories", "knowledge"]) {
        await this.database
          .collection(collection)
          .createIndex({ embedding: 1 });
      }
      console.log("Standard embedding indexes created successfully");
    } catch (error) {
      console.error("Failed to create standard embedding indexes:", error);
    }
  }

  async init() {
    if (this.isConnected) {
      return;
    }

    try {
      await this.db.connect();
      this.database = this.db.db(this.databaseName);

      await this.initializeCollections();
      await this.initializeStandardIndexes();
      await this.initializeVectorSearch();

      try {
        // Enable sharding for better performance
        await this.database.command({
          enableSharding: this.database.databaseName,
        });
        await this.database.command({
          shardCollection: `${this.database.databaseName}.memories`,
          key: { roomId: "hashed" },
        });
      } catch (error) {
        console.log(
          "Sharding may already be enabled or insufficient permissions",
          error,
        );
      }

      this.isConnected = true;
    } catch (error) {
      this.isConnected = false;
      this.isVectorSearchIndexComputable = false;
      console.error("Failed to initialize MongoDB connection:", error);
      throw error;
    }
  }

  async close() {
    if (this.isConnected) {
      await this.db.close();
      this.isConnected = false;
    }
  }

  private async ensureConnection() {
    if (!this.isConnected) {
      await this.init();
    }
  }

  // Updated database operation methods with connection checks
  async getRoom(roomId: UUID): Promise<UUID | null> {
    await this.ensureConnection();
    const room = await this.database
      .collection("rooms")
      .findOne({ id: roomId });
    return room ? room.id : null;
  }

  async getParticipantsForAccount(userId: UUID): Promise<Participant[]> {
    await this.ensureConnection();
    return await this.database
      .collection("participants")
      .find({ userId })
      .toArray();
  }

  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    await this.ensureConnection();
    const participants = await this.database
      .collection("participants")
      .find({ roomId })
      .toArray();
    return participants.map((p) => p.userId);
  }

  async getParticipantUserState(
    roomId: UUID,
    userId: UUID,
  ): Promise<"FOLLOWED" | "MUTED" | null> {
    await this.ensureConnection();
    const participant = await this.database
      .collection("participants")
      .findOne({ roomId, userId });
    return participant?.userState ?? null;
  }

  async setParticipantUserState(
    roomId: UUID,
    userId: UUID,
    state: "FOLLOWED" | "MUTED" | null,
  ): Promise<void> {
    await this.ensureConnection();
    await this.database
      .collection("participants")
      .updateOne({ roomId, userId }, { $set: { userState: state } });
  }

  async getAccountById(userId: UUID): Promise<Account | null> {
    await this.ensureConnection();
    const account = await this.database
      .collection("accounts")
      .findOne({ id: userId });
    if (!account) return null;
    return {
      ...account,
      details:
        typeof account.details === "string"
          ? JSON.parse(account.details)
          : account.details,
    };
  }

  async createAccount(account: Account): Promise<boolean> {
    await this.ensureConnection();
    try {
      await this.database.collection("accounts").insertOne({
        ...account,
        id: account.id ?? v4(),
        details: JSON.stringify(account.details),
        createdAt: new Date(),
      });
      return true;
    } catch (error) {
      console.error("Error creating account:", error);
      return false;
    }
  }

  async getActorDetails(params: { roomId: UUID }): Promise<Actor[]> {
    await this.ensureConnection();
    const actors = await this.database
      .collection("participants")
      .aggregate([
        { $match: { roomId: params.roomId } },
        {
          $lookup: {
            from: "accounts",
            localField: "userId",
            foreignField: "id",
            as: "account",
          },
        },
        { $unwind: "$account" },
        {
          $project: {
            id: "$account.id",
            name: "$account.name",
            username: "$account.username",
            details: "$account.details",
          },
        },
      ])
      .toArray();

    return actors
      .map((actor) => ({
        ...actor,
        details:
          typeof actor.details === "string"
            ? JSON.parse(actor.details)
            : actor.details,
      }))
      .filter((actor): actor is Actor => actor !== null);
  }

  async getMemoriesByRoomIds(params: {
    agentId: UUID;
    roomIds: UUID[];
    tableName: string;
  }): Promise<Memory[]> {
    await this.ensureConnection();
    if (!params.tableName) {
      params.tableName = "messages";
    }

    const memories = await this.database
      .collection("memories")
      .find({
        type: params.tableName,
        agentId: params.agentId,
        roomId: { $in: params.roomIds },
      })
      .toArray();

    return memories.map((memory) => ({
      ...memory,
      content:
        typeof memory.content === "string"
          ? JSON.parse(memory.content)
          : memory.content,
    }));
  }

  async getMemoryById(memoryId: UUID): Promise<Memory | null> {
    await this.ensureConnection();
    const memory = await this.database
      .collection("memories")
      .findOne({ id: memoryId });
    if (!memory) return null;

    return {
      ...memory,
      content:
        typeof memory.content === "string"
          ? JSON.parse(memory.content)
          : memory.content,
    };
  }

  async createMemory(memory: Memory, tableName: string): Promise<void> {
    await this.ensureConnection();
    try {
      let isUnique = true;

      if (memory.embedding) {
        const similarMemories = await this.searchMemories({
          tableName,
          roomId: memory.roomId,
          agentId: memory.agentId,
          embedding: memory.embedding,
          match_threshold: 0.95,
          match_count: 1,
          unique: isUnique,
        });
        // const similarMemories = await this.searchMemoriesByEmbedding(
        //     memory.embedding,
        //     {
        //         tableName,
        //         agentId: memory.agentId,
        //         roomId: memory.roomId,
        //         match_threshold: 0.95,
        //         count: 1
        //     }
        // );
        isUnique = similarMemories.length === 0;
      }
      const createdAt = memory.createdAt ?? Date.now();

      await this.database.collection("memories").insertOne({
        id: memory.id ?? v4(),
        type: tableName,
        content: {
          content: memory.content,
          ...memory.content,
        },
        embedding: memory.embedding ? Array.from(memory.embedding) : null,
        userId: memory.userId,
        roomId: memory.roomId,
        agentId: memory.agentId,
        unique: isUnique,
        createdAt: new Date(createdAt),
      });
    } catch (e) {
      elizaLogger.error(e);
    }
  }

  private async searchMemoriesFallback(params: {
    embedding: number[];
    query: any;
    limit?: number;
  }): Promise<Memory[]> {
    await this.ensureConnection();
    // Implement a basic similarity search using standard MongoDB operations
    const memories = await this.database
      .collection("memories")
      .find(params.query)
      .limit(params.limit || 10)
      .toArray();

    // Sort by cosine similarity computed in application
    return memories
      .map((memory) => ({
        ...memory,
        similarity: this.cosineSimilarity(params.embedding, memory.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .map((memory) => ({
        ...memory,
        createdAt:
          typeof memory.createdAt === "string"
            ? Date.parse(memory.createdAt)
            : memory.createdAt,
        content:
          typeof memory.content === "string"
            ? JSON.parse(memory.content)
            : memory.content,
      }));
  }

  private cosineSimilarity(
    a: Float32Array | number[],
    b: Float32Array | number[],
  ): number {
    const aArr = Array.from(a);
    const bArr = Array.from(b);
    const dotProduct = aArr.reduce((sum, val, i) => sum + val * bArr[i], 0);
    const magnitudeA = Math.sqrt(aArr.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(bArr.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitudeA * magnitudeB);
  }

  async searchMemories(params: {
    tableName: string;
    roomId: UUID;
    agentId?: UUID;
    embedding: number[];
    match_threshold: number;
    match_count: number;
    unique: boolean;
  }): Promise<Memory[]> {
    await this.ensureConnection();
    const query = {
      type: params.tableName,
      roomId: params.roomId,
      ...(params.unique && { unique: true }),
      ...(params.agentId && { agentId: params.agentId }),
    };

    if (this.hasVectorSearch) {
      const pipeline = [
        {
          $search: {
            vectorSearch: {
              queryVector: new Float32Array(params.embedding),
              path: "embedding",
              numCandidates: params.match_count * 2,
              limit: params.match_count,
              index: "vector_index",
            },
          },
        },
        { $match: query },
      ];

      try {
        const memories = await this.database
          .collection("memories")
          .aggregate(pipeline)
          .toArray();

        return memories.map((memory) => ({
          ...memory,
          createdAt:
            typeof memory.createdAt === "string"
              ? Date.parse(memory.createdAt)
              : memory.createdAt,
          content:
            typeof memory.content === "string"
              ? JSON.parse(memory.content)
              : memory.content,
        }));
      } catch (error) {
        console.log(
          "Vector search failed, falling back to standard search",
          error,
        );
        return this.searchMemoriesFallback({
          embedding: params.embedding,
          query,
          limit: params.match_count,
        });
      }
    }

    return this.searchMemoriesFallback({
      embedding: params.embedding,
      query,
      limit: params.match_count,
    });
  }

  async searchMemoriesByEmbedding(
    embedding: number[],
    params: {
      match_threshold?: number;
      count?: number;
      roomId?: UUID;
      agentId: UUID;
      unique?: boolean;
      tableName: string;
    },
  ): Promise<Memory[]> {
    await this.ensureConnection();
    const pipeline = [
      {
        $search: {
          vectorSearch: {
            queryVector: Array.from(embedding),
            path: "embedding",
            numCandidates: (params.count ?? 10) * 2,
            limit: params.count,
            index: "vector_index",
          },
        },
      },
      {
        $match: {
          type: params.tableName,
          agentId: params.agentId,
          ...(params.unique && { unique: true }),
          ...(params.roomId && { roomId: params.roomId }),
        },
      },
    ];

    const memories = await this.database
      .collection("memories")
      .aggregate(pipeline)
      .toArray();

    return memories.map((memory) => ({
      ...memory,
      createdAt:
        typeof memory.createdAt === "string"
          ? Date.parse(memory.createdAt)
          : memory.createdAt,
      content:
        typeof memory.content === "string"
          ? JSON.parse(memory.content)
          : memory.content,
    }));
  }

  /**
   * Optimized Levenshtein distance calculation with early termination
   * and matrix reuse for better performance
   */
  private calculateLevenshteinDistanceOptimized(
    str1: string,
    str2: string,
  ): number {
    // Early termination for identical strings
    if (str1 === str2) return 0;

    // Early termination for empty strings
    if (str1.length === 0) return str2.length;
    if (str2.length === 0) return str1.length;

    // Use shorter string as inner loop for better performance
    if (str1.length > str2.length) {
      [str1, str2] = [str2, str1];
    }

    // Reuse matrix to avoid garbage collection
    const matrix = this.getLevenshteinMatrix(str1.length + 1, str2.length + 1);
    const expectedRows = str1.length + 1;
    const expectedCols = str2.length + 1;

    // Defensive check: Ensure matrix is an array and has enough rows.
    if (!matrix || matrix.length < expectedRows) {
      const actualRows = matrix
        ? matrix.length
        : matrix === null
          ? "null"
          : "undefined";
      console.error(
        `[MongoDBDatabaseAdapter:calculateLevenshteinDistanceOptimized] Critical Error: Levenshtein matrix has insufficient rows. ` +
          `Expected at least: ${expectedRows}, Got: ${actualRows}. str1.length: ${str1.length}.`,
      );
      throw new Error(
        `Internal Levenshtein error: Matrix row dimension incorrect (expected ${expectedRows}, got ${actualRows}).`,
      );
    }

    // Initialize first row and column
    for (let i = 0; i <= str1.length; i++) {
      // Defensive check: Ensure the current row array exists.
      if (matrix[i] === undefined) {
        console.error(
          `[MongoDBDatabaseAdapter:calculateLevenshteinDistanceOptimized] Error: Levenshtein matrix[${i}] is undefined during row initialization. ` +
            `Matrix length: ${matrix.length}, str1.length: ${str1.length}. This indicates a severe matrix setup issue.`,
        );
        throw new Error(
          `Internal Levenshtein error: Matrix row ${i} is unexpectedly undefined.`,
        );
      }
      // Defensive check: Ensure the current row array has space for the 0-th column.
      // This should be guaranteed if getLevenshteinMatrix ensures column dimensions,
      // but adding it for extreme defensiveness.
      if (matrix[i].length < 1 && expectedCols > 0) {
        // Only matters if we expect columns
        console.error(
          `[MongoDBDatabaseAdapter:calculateLevenshteinDistanceOptimized] Error: Levenshtein matrix[${i}] is an empty array but columns are expected. ` +
            `matrix[${i}].length: ${matrix[i].length}, expectedCols: ${expectedCols}.`,
        );
        throw new Error(
          `Internal Levenshtein error: Matrix row ${i} is an empty array.`,
        );
      }
      matrix[i][0] = i;
    }

    // Defensive check: Ensure the first row (matrix[0]) exists before column initialization.
    // This should have been covered by the matrix.length check and matrix[i] check for i=0.
    if (matrix[0] === undefined) {
      console.error(
        `[MongoDBDatabaseAdapter:calculateLevenshteinDistanceOptimized] Error: Levenshtein matrix[0] is undefined before column initialization. ` +
          `This indicates a severe matrix setup issue.`,
      );
      throw new Error(
        `Internal Levenshtein error: Matrix row 0 is unexpectedly undefined for column init.`,
      );
    }

    // Defensive check: Ensure matrix[0] has enough columns.
    if (matrix[0].length < expectedCols) {
      console.error(
        `[MongoDBDatabaseAdapter:calculateLevenshteinDistanceOptimized] Critical Error: Levenshtein matrix[0] has insufficient columns. ` +
          `Expected at least: ${expectedCols}, Got: ${matrix[0].length}. str2.length: ${str2.length}.`,
      );
      throw new Error(
        `Internal Levenshtein error: Matrix column dimension incorrect for row 0 (expected ${expectedCols}, got ${matrix[0].length}).`,
      );
    }

    for (let j = 0; j <= str2.length; j++) {
      // The matrix[0].length check above should ensure matrix[0][j] is a valid access.
      matrix[0][j] = j;
    }

    // Calculate minimum edit distance
    for (let i = 1; i <= str1.length; i++) {
      for (let j = 1; j <= str2.length; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1, // deletion
          );
        }
      }
    }

    return matrix[str1.length][str2.length];
  }

  // Cache for reusing Levenshtein distance matrix
  private levenshteinMatrix: number[][] = [];

  private getLevenshteinMatrix(rows: number, cols: number): number[][] {
    // Ensure the cached matrix is large enough for the current request.
    // `rows` is str1.length + 1, `cols` is str2.length + 1.
    // Both `rows` and `cols` will be >= 1 due to prior checks in calculateLevenshteinDistanceOptimized.
    if (
      this.levenshteinMatrix.length < rows ||
      // Check if the first row exists before checking its length, or if cols are needed but no rows exist.
      (this.levenshteinMatrix.length > 0 &&
        (this.levenshteinMatrix[0]?.length || 0) < cols) ||
      (this.levenshteinMatrix.length === 0 && cols > 0) // Handles case where matrix is [] but cols are needed
    ) {
      // If current matrix is too small in either dimension, create a new one.
      // The fill(0) is not strictly necessary as the calling function initializes
      // the parts it uses, but it's safer.
      this.levenshteinMatrix = Array(rows)
        .fill(null)
        .map(() => Array(cols).fill(0));
    }
    // If the matrix was already large enough, it's reused.
    // The calculateLevenshteinDistanceOptimized function will only use up to matrix[rows-1][cols-1].
    return this.levenshteinMatrix;
  }

  async getCachedEmbeddings(opts: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    await this.ensureConnection();

    let results: { embedding: number[]; levenshtein_score: number }[] = [];

    try {
      const pipelineRelevance = [
        {
          $search: {
            index: "memoriesContent",
            compound: {
              must: [
                {
                  text: {
                    query: this.sanitizeQuery(opts.query_input),
                    path: [
                      `content.${opts.query_field_name}.${opts.query_field_sub_name}`,
                      "content.text",
                    ],
                  },
                },
              ],
              filter: [
                {
                  text: {
                    query: opts.query_table_name,
                    path: "type",
                  },
                },
              ],
            },
          },
        },
        {
          $addFields: {
            score: { $meta: "searchScore" },
          },
        },
        {
          $sort: {
            score: -1, // Sort by relevance score in descending order
          },
        },
        { $limit: opts.query_match_count * 2 },
      ];
      const dataRelevanceAndLevenshtein = await this.database
        .collection("memories")
        .aggregate(pipelineRelevance)
        .toArray();
      results = dataRelevanceAndLevenshtein
        .map((memory) => {
          try {
            const levenshteinDistance =
              this.calculateLevenshteinDistanceOptimized(
                opts.query_input,
                memory.content[opts.query_field_name][
                  opts.query_field_sub_name
                ],
              );
            return {
              embedding: memory.embedding,
              levenshtein_score: levenshteinDistance,
            };
          } catch (error) {
            console.warn(
              `[MongoDBDatabaseAdapter:getCachedEmbeddings] Error processing memory document: ${error}`,
            );
            return [];
          }
        })
        // smaller levenshtein_score should be first
        .sort((a, b) => {
          if (a.levenshtein_score < b.levenshtein_score) return -1;
          if (a.levenshtein_score > b.levenshtein_score) return 1;
          return 0;
        })
        .slice(0, opts.query_match_count);

      return results;
    } catch (error) {
      console.error(
        "[MongoDBDatabaseAdapter:getCachedEmbeddings] Error in getCachedEmbeddings:",
        error,
      );
      if (results.length > 0) {
        console.log(
          "[MongoDBDatabaseAdapter:getCachedEmbeddings] Returning partial results",
        );
        return results;
      }
      return [];
    }
  }

  // Basic usage with English stopwords, it works with other languages too  but its not optimized
  private sanitizeQuery(input: string): string {
    // Convert to lowercase and split into words
    const words = input.toLowerCase().split(/\s+/);

    const filteredWords = removeStopwords(words, eng);

    return filteredWords.join(" ");
  }

  async updateGoalStatus(params: {
    goalId: UUID;
    status: GoalStatus;
  }): Promise<void> {
    await this.ensureConnection();
    await this.database
      .collection("goals")
      .updateOne({ id: params.goalId }, { $set: { status: params.status } });
  }

  async log(params: {
    body: { [key: string]: unknown };
    userId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void> {
    await this.ensureConnection();
    await this.database.collection("logs").insertOne({
      id: v4(),
      body: JSON.stringify(params.body),
      userId: params.userId,
      roomId: params.roomId,
      type: params.type,
      createdAt: new Date(),
    });
  }

  async getMemories(params: {
    roomId: UUID;
    count?: number;
    unique?: boolean;
    tableName: string;
    agentId: UUID;
    start?: number;
    end?: number;
  }): Promise<Memory[]> {
    await this.ensureConnection();
    if (!params.tableName) {
      throw new Error("tableName is required");
    }
    if (!params.roomId) {
      throw new Error("roomId is required");
    }

    const query: any = {
      type: params.tableName,
      agentId: params.agentId,
      roomId: params.roomId,
    };

    if (params.unique) {
      query.unique = true;
    }

    if (params.start || params.end) {
      query.createdAt = {};
      if (params.start) query.createdAt.$gte = new Date(params.start);
      if (params.end) query.createdAt.$lte = new Date(params.end);
    }

    const memories = await this.database
      .collection("memories")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(params.count || 0)
      .toArray();

    return memories.map((memory) => ({
      ...memory,
      createdAt: new Date(memory.createdAt).getTime(),
      content:
        typeof memory.content === "string"
          ? JSON.parse(memory.content)
          : memory.content,
    }));
  }

  async removeMemory(memoryId: UUID, tableName: string): Promise<void> {
    await this.ensureConnection();
    await this.database.collection("memories").deleteOne({
      id: memoryId,
      type: tableName,
    });
  }

  async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
    await this.ensureConnection();
    await this.database.collection("memories").deleteMany({
      roomId,
      type: tableName,
    });
  }

  async countMemories(
    roomId: UUID,
    unique = true,
    tableName = "",
  ): Promise<number> {
    await this.ensureConnection();
    if (!tableName) {
      throw new Error("tableName is required");
    }

    const query: any = {
      type: tableName,
      roomId,
    };

    if (unique) {
      query.unique = true;
    }

    return await this.database.collection("memories").countDocuments(query);
  }

  async getGoals(params: {
    roomId: UUID;
    userId?: UUID | null;
    onlyInProgress?: boolean;
    count?: number;
  }): Promise<Goal[]> {
    await this.ensureConnection();
    const query: any = { roomId: params.roomId };

    if (params.userId) {
      query.userId = params.userId;
    }

    if (params.onlyInProgress) {
      query.status = "IN_PROGRESS";
    }

    const goals = await this.database
      .collection("goals")
      .find(query)
      .limit(params.count || 0)
      .toArray();

    return goals.map((goal) => ({
      ...goal,
      objectives:
        typeof goal.objectives === "string"
          ? JSON.parse(goal.objectives)
          : goal.objectives,
    }));
  }

  async updateGoal(goal: Goal): Promise<void> {
    await this.ensureConnection();
    await this.database.collection("goals").updateOne(
      { id: goal.id },
      {
        $set: {
          name: goal.name,
          status: goal.status,
          objectives: JSON.stringify(goal.objectives),
        },
      },
    );
  }

  async createGoal(goal: Goal): Promise<void> {
    await this.ensureConnection();
    await this.database.collection("goals").insertOne({
      ...goal,
      id: goal.id ?? v4(),
      objectives: JSON.stringify(goal.objectives),
      createdAt: new Date(),
    });
  }

  async removeGoal(goalId: UUID): Promise<void> {
    await this.ensureConnection();
    await this.database.collection("goals").deleteOne({ id: goalId });
  }

  async removeAllGoals(roomId: UUID): Promise<void> {
    await this.ensureConnection();
    await this.database.collection("goals").deleteMany({ roomId });
  }

  async createRoom(roomId?: UUID): Promise<UUID> {
    await this.ensureConnection();
    const newRoomId = roomId || (v4() as UUID);
    try {
      await this.database.collection("rooms").insertOne({
        id: newRoomId,
        createdAt: new Date(),
      });
      return newRoomId;
    } catch (error) {
      console.error("Error creating room:", error);
      throw error; // Throw error instead of silently continuing
    }
  }

  async removeRoom(roomId: UUID): Promise<void> {
    await this.ensureConnection();
    try {
      await this.database.collection("rooms").deleteOne({ id: roomId });
    } catch (error) {
      console.error("Error removing room:", error);
      throw error;
    }
  }

  async getRoomsForParticipant(userId: UUID): Promise<UUID[]> {
    await this.ensureConnection();
    const rooms = await this.database
      .collection("participants")
      .find({ userId })
      .project({ roomId: 1 })
      .toArray();
    return rooms.map((r) => r.roomId);
  }

  async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
    await this.ensureConnection();
    const pipeline = [
      { $match: { userId: { $in: userIds } } },
      { $sort: { createdAt: -1 } },
      { $limit: 20 },
      { $group: { _id: null, rooms: { $addToSet: "$roomId" } } },
      { $project: { _id: 0, rooms: 1 } },
    ];
    const rooms = await this.database
      .collection("participants")
      .aggregate(pipeline)
      .toArray();
    if (rooms.length > 0) {
      return rooms[0]["rooms"];
    }
    return [];
  }

  async addParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
    await this.ensureConnection();
    try {
      await this.database.collection("participants").insertOne({
        id: v4(),
        userId,
        roomId,
        createdAt: new Date(),
      });
      return true;
    } catch (error) {
      console.log("Error adding participant", error);
      return false;
    }
  }

  async removeParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
    await this.ensureConnection();
    try {
      await this.database.collection("participants").deleteOne({
        userId,
        roomId,
      });
      return true;
    } catch (error) {
      console.log("Error removing participant", error);
      return false;
    }
  }

  async createRelationship(params: {
    userA: UUID;
    userB: UUID;
  }): Promise<boolean> {
    await this.ensureConnection();
    if (!params.userA || !params.userB) {
      throw new Error("userA and userB are required");
    }

    try {
      await this.database.collection("relationships").insertOne({
        id: v4(),
        userA: params.userA,
        userB: params.userB,
        userId: params.userA,
        createdAt: new Date(),
      });
      return true;
    } catch (error) {
      console.log("Error creating relationship", error);
      return false;
    }
  }

  async getRelationship(params: {
    userA: UUID;
    userB: UUID;
  }): Promise<Relationship | null> {
    await this.ensureConnection();
    return await this.database.collection("relationships").findOne({
      $or: [
        { userA: params.userA, userB: params.userB },
        { userA: params.userB, userB: params.userA },
      ],
    });
  }

  async getRelationships(params: { userId: UUID }): Promise<Relationship[]> {
    await this.ensureConnection();
    return await this.database
      .collection("relationships")
      .find({
        $or: [{ userA: params.userId }, { userB: params.userId }],
      })
      .toArray();
  }

  async getCache(params: {
    key: string;
    agentId: UUID;
  }): Promise<string | undefined> {
    await this.ensureConnection();
    const cached = await this.database.collection("cache").findOne({
      key: params.key,
      agentId: params.agentId,
      expiresAt: { $gt: new Date() },
    });
    return cached?.value;
  }

  async setCache(params: {
    key: string;
    agentId: UUID;
    value: string;
  }): Promise<boolean> {
    await this.ensureConnection();
    try {
      await this.database.collection("cache").updateOne(
        { key: params.key, agentId: params.agentId },
        {
          $set: {
            value: params.value,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours expiry
          },
        },
        { upsert: true },
      );
      return true;
    } catch (error) {
      console.log("Error setting cache", error);
      return false;
    }
  }

  async deleteCache(params: { key: string; agentId: UUID }): Promise<boolean> {
    await this.ensureConnection();
    try {
      await this.database.collection("cache").deleteOne({
        key: params.key,
        agentId: params.agentId,
      });
      return true;
    } catch (error) {
      console.log("Error removing cache", error);
      return false;
    }
  }

  async getKnowledge(params: {
    id?: UUID;
    agentId: UUID;
    limit?: number;
    query?: string;
  }): Promise<RAGKnowledgeItem[]> {
    await this.ensureConnection();

    const query: any = {
      $or: [{ agentId: params.agentId }, { isShared: true }],
    };

    if (params.id) {
      query.id = params.id;
    }

    const knowledge = await this.database
      .collection("knowledge")
      .find(query)
      .limit(params.limit || 0)
      .toArray();

    return knowledge.map((item) => ({
      id: item.id,
      agentId: item.agentId,
      content:
        typeof item.content === "string"
          ? JSON.parse(item.content)
          : item.content,
      embedding: item.embedding ? new Float32Array(item.embedding) : undefined,
      createdAt:
        typeof item.createdAt === "string"
          ? Date.parse(item.createdAt)
          : item.createdAt,
    }));
  }

  async searchKnowledge(params: {
    agentId: UUID;
    embedding: Float32Array;
    match_threshold: number;
    match_count: number;
    searchText?: string;
  }): Promise<RAGKnowledgeItem[]> {
    await this.ensureConnection();

    const cacheKey = `embedding_${params.agentId}_${params.searchText}`;
    const cachedResult = await this.getCache({
      key: cacheKey,
      agentId: params.agentId,
    });

    if (cachedResult) {
      return JSON.parse(cachedResult);
    }

    try {
      let results: KnowledgeDocument[];

      if (this.hasVectorSearch) {
        try {
          results = await this.vectorSearchKnowledge(params);
        } catch (error) {
          console.log(
            "Vector search failed, falling back to standard search",
            error,
          );
          results = await this.fallbackSearchKnowledge(params);
        }
      } else {
        results = await this.fallbackSearchKnowledge(params);
      }

      const mappedResults = results.map((item) => ({
        id: item.id,
        agentId: item.agentId, // This will always be UUID
        content:
          typeof item.content === "string"
            ? JSON.parse(item.content)
            : item.content,
        embedding: item.embedding
          ? new Float32Array(item.embedding)
          : undefined,
        createdAt:
          typeof item.createdAt === "string"
            ? Date.parse(item.createdAt)
            : item.createdAt,
        similarity: (item as any).combinedScore || 0,
      })) as RAGKnowledgeItem[];

      await this.setCache({
        key: cacheKey,
        agentId: params.agentId,
        value: JSON.stringify(mappedResults),
      });

      return mappedResults;
    } catch (error) {
      console.error("Error in searchKnowledge:", error);
      throw error;
    }
  }

  private async vectorSearchKnowledge(params: {
    agentId: UUID;
    embedding: Float32Array;
    match_threshold: number;
    match_count: number;
    searchText?: string;
  }): Promise<KnowledgeDocument[]> {
    const pipeline = [
      {
        $search: {
          vectorSearch: {
            queryVector: Array.from(params.embedding),
            path: "embedding",
            numCandidates: params.match_count * 2,
            limit: params.match_count * 2,
            index: "vector_index",
          },
        },
      },
      ...this.getKnowledgeSearchPipeline(params),
    ];

    return await this.database
      .collection("knowledge")
      .aggregate(pipeline)
      .toArray();
  }

  private async fallbackSearchKnowledge(params: {
    agentId: UUID;
    embedding: Float32Array;
    match_threshold: number;
    match_count: number;
    searchText?: string;
  }): Promise<KnowledgeDocument[]> {
    const pipeline = [
      {
        $match: {
          $or: [{ agentId: params.agentId }, { isShared: true, agentId: null }],
        },
      },
      ...this.getKnowledgeSearchPipeline(params),
    ];

    return await this.database
      .collection("knowledge")
      .aggregate(pipeline)
      .toArray();
  }

  private getKnowledgeSearchPipeline(params: {
    agentId: UUID;
    embedding: Float32Array;
    match_threshold: number;
    searchText?: string;
  }): object[] {
    return [
      {
        $addFields: {
          vectorScore: this.hasVectorSearch
            ? { $meta: "vectorSearchScore" }
            : {
                $let: {
                  vars: {
                    embedding: { $ifNull: ["$embedding", []] },
                  },
                  in: {
                    $cond: [
                      { $eq: [{ $size: "$$embedding" }, 0] },
                      0,
                      {
                        $divide: [
                          1,
                          {
                            $add: [
                              1,
                              {
                                $function: {
                                  body: this.cosineSimilarity.toString(),
                                  args: [params.embedding, "$$embedding"],
                                  lang: "js",
                                },
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                },
              },
          keywordScore: this.calculateKeywordScore(params.searchText),
        },
      },
      {
        $addFields: {
          combinedScore: { $multiply: ["$vectorScore", "$keywordScore"] },
        },
      },
      {
        $match: {
          $or: [
            { vectorScore: { $gte: params.match_threshold } },
            {
              $and: [
                { keywordScore: { $gt: 1.0 } },
                { vectorScore: { $gte: 0.3 } },
              ],
            },
          ],
        },
      },
      { $sort: { combinedScore: -1 } },
    ];
  }

  private calculateKeywordScore(searchText?: string): object {
    return {
      $multiply: [
        {
          $cond: [
            searchText
              ? {
                  $regexMatch: {
                    input: { $toLower: "$content.text" },
                    regex: new RegExp(searchText.toLowerCase()),
                  },
                }
              : false,
            3.0,
            1.0,
          ],
        },
        {
          $cond: [
            { $eq: ["$content.metadata.isChunk", true] },
            1.5,
            {
              $cond: [{ $eq: ["$content.metadata.isMain", true] }, 1.2, 1.0],
            },
          ],
        },
      ],
    };
  }

  // Update error handling in createKnowledge
  async createKnowledge(knowledge: RAGKnowledgeItem): Promise<void> {
    await this.ensureConnection();

    try {
      const metadata = knowledge.content.metadata || {};
      const isShared = metadata.isShared || false;

      const doc = {
        id: knowledge.id,
        agentId: knowledge.agentId,
        content:
          typeof knowledge.content === "string"
            ? knowledge.content
            : JSON.stringify(knowledge.content),
        embedding: knowledge.embedding ? Array.from(knowledge.embedding) : null,
        createdAt: knowledge.createdAt || Date.now(),
        isMain: metadata.isMain || false,
        originalId: metadata.originalId || null,
        chunkIndex: metadata.chunkIndex || null,
        isShared,
      };

      await this.database
        .collection("knowledge")
        .updateOne(
          { id: knowledge.id },
          { $setOnInsert: doc },
          { upsert: true },
        );
    } catch (err) {
      if (err instanceof Error) {
        const error = err as Error & { code?: number };
        const isShared = knowledge.content.metadata?.isShared;

        if (isShared && error.code === 11000) {
          console.info(
            `Shared knowledge ${knowledge.id} already exists, skipping`,
          );
          return;
        }

        console.error(`Error creating knowledge ${knowledge.id}:`, error);
        throw error;
      }
      throw err;
    }
  }

  async removeKnowledge(id: UUID): Promise<void> {
    await this.ensureConnection();
    await this.database.collection("knowledge").deleteOne({ id });
  }

  async clearKnowledge(agentId: UUID, shared?: boolean): Promise<void> {
    await this.ensureConnection();
    const query = shared
      ? { $or: [{ agentId }, { isShared: true }] }
      : { agentId };

    try {
      await this.database.collection("knowledge").deleteMany(query);
    } catch (error) {
      console.error(`Error clearing knowledge for agent ${agentId}:`, error);
      throw error;
    }
  }

  async getMemoriesByIds(
    memoryIds: UUID[],
    tableName?: string,
  ): Promise<Memory[]> {
    await this.ensureConnection();
    const collection = tableName || "memories";

    try {
      const memories = await this.database
        .collection(collection)
        .find({ id: { $in: memoryIds } })
        .toArray();

      return memories.map((memory) => ({
        id: memory.id,
        roomId: memory.roomId,
        agentId: memory.agentId,
        type: memory.type,
        content: memory.content,
        embedding: memory.embedding,
        createdAt:
          memory.createdAt instanceof Date
            ? memory.createdAt.getTime()
            : memory.createdAt,
        metadata: memory.metadata || {},
      }));
    } catch (error) {
      elizaLogger.error("Failed to get memories by IDs:", error);
      return [];
    }
  }
}

export const mongoDBAdapter: Adapter = {
  init: (runtime: IAgentRuntime) => {
    const MONGODB_CONNECTION_STRING = runtime.getSetting(
      "MONGODB_CONNECTION_STRING",
    );
    if (MONGODB_CONNECTION_STRING) {
      elizaLogger.log("Initializing database on MongoDB Atlas");
      const client = new MongoClient(MONGODB_CONNECTION_STRING, {
        maxPoolSize: 100,
        minPoolSize: 5,
        maxIdleTimeMS: 60000,
        connectTimeoutMS: 10000,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        compressors: ["zlib"],
        retryWrites: true,
        retryReads: true,
      });

      const dbName = runtime.getSetting("MONGODB_DATABASE") || "elizaAgent";
      const db = new MongoDBDatabaseAdapter(client, dbName);

      // Test the connection
      db.init()
        .then(() => {
          elizaLogger.success("Successfully connected to MongoDB Atlas");
        })
        .catch((error) => {
          elizaLogger.error("Failed to connect to MongoDB Atlas:", error);
          throw error; // Re-throw to handle it in the calling code
        });

      return db;
    } else {
      throw new Error("MONGODB_CONNECTION_STRING is not set");
    }
  },
};
