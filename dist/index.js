// src/index.ts
import {
  DatabaseAdapter,
  elizaLogger
} from "@elizaos/core";
import { v4 } from "uuid";
var MongoDBDatabaseAdapter = class extends DatabaseAdapter {
  constructor(client, databaseName) {
    super();
    this.isConnected = false;
    // Cache for reusing Levenshtein distance matrix
    this.levenshteinMatrix = [];
    this.maxMatrixSize = 0;
    this.db = client;
    this.databaseName = databaseName;
    this.hasVectorSearch = false;
    this.isConnected = false;
    this.isVectorSearchIndexComputable = true;
  }
  async initializeCollections() {
    const collections = [
      "memories",
      "participants",
      "cache",
      "knowledge",
      "rooms",
      "accounts",
      "goals",
      "logs",
      "relationships"
    ];
    for (const collectionName of collections) {
      try {
        await this.database.createCollection(collectionName);
        console.log(`Collection ${collectionName} created or already exists`);
      } catch (error) {
        if (error.code !== 48) {
          console.error(`Error creating collection ${collectionName}:`, error);
        }
      }
    }
  }
  async initializeStandardIndexes() {
    const collectionsWithIndexes = [
      {
        collectionName: "memories",
        indexes: [
          { key: { type: 1, roomId: 1, agentId: 1, createdAt: -1 } },
          { key: { content: "text" }, options: { weights: { content: 10 } } }
        ]
      },
      {
        collectionName: "participants",
        indexes: [
          { key: { userId: 1, roomId: 1 }, options: { unique: true } }
        ]
      },
      {
        collectionName: "cache",
        indexes: [
          { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } }
        ]
      },
      {
        collectionName: "knowledge",
        indexes: [
          { key: { agentId: 1 } },
          { key: { isShared: 1 } },
          { key: { id: 1 }, options: { unique: true } },
          { key: { "content.text": "text" } }
        ]
      }
    ];
    await Promise.all(collectionsWithIndexes.map(async ({ collectionName, indexes }) => {
      const collection = this.database.collection(collectionName);
      const existingIndexes = await collection.listIndexes().toArray();
      for (const index of indexes) {
        const indexExists = existingIndexes.some(
          (existingIndex) => JSON.stringify(existingIndex.key) === JSON.stringify(index.key)
        );
        if (!indexExists) {
          console.log(`Creating index for ${collectionName}:`, index.key);
          await collection.createIndex(index.key, index.options || {});
        } else {
          console.log(`Index already exists for ${collectionName}:`, index.key);
        }
      }
    }));
  }
  async initializeVectorSearch() {
    var _a;
    try {
      const dbStatus = await this.database.admin().serverStatus();
      const vectorSearchSupported = ((_a = dbStatus.vectorSearch) == null ? void 0 : _a.supported) === true;
      if (vectorSearchSupported && this.isVectorSearchIndexComputable) {
        const vectorSearchConfig = {
          name: "vector_index",
          definition: {
            vectorSearchConfig: {
              dimensions: 1536,
              similarity: "cosine",
              numLists: 100,
              efConstruction: 128
            }
          }
        };
        try {
          for (const collection of ["memories", "knowledge"]) {
            await this.database.collection(collection).createIndex(
              { embedding: "vectorSearch" },
              vectorSearchConfig
            );
          }
          this.hasVectorSearch = true;
          console.log("Vector search capabilities are available and enabled");
          const dbInfo = await this.database.admin().command({ listDatabases: 1, nameOnly: true });
          const memoriesStats = await this.database.collection("memories").stats();
          if ((dbInfo == null ? void 0 : dbInfo.sharded) && (memoriesStats == null ? void 0 : memoriesStats.sharded)) {
            this.isVectorSearchIndexComputable = false;
            this.hasVectorSearch = false;
            await this.createStandardEmbeddingIndexes();
          }
        } catch (error) {
          console.log("Vector search initialization failed, falling back to standard search", error);
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
      console.log("Error checking vector search capability, defaulting to standard search", error);
      this.isVectorSearchIndexComputable = false;
      this.hasVectorSearch = false;
      await this.createStandardEmbeddingIndexes();
    }
  }
  async createStandardEmbeddingIndexes() {
    try {
      for (const collection of ["memories", "knowledge"]) {
        await this.database.collection(collection).createIndex({ embedding: 1 });
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
        await this.database.command({
          enableSharding: this.database.databaseName
        });
        await this.database.command({
          shardCollection: `${this.database.databaseName}.memories`,
          key: { roomId: "hashed" }
        });
      } catch (error) {
        console.log("Sharding may already be enabled or insufficient permissions", error);
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
  async ensureConnection() {
    if (!this.isConnected) {
      await this.init();
    }
  }
  // Updated database operation methods with connection checks
  async getRoom(roomId) {
    await this.ensureConnection();
    const room = await this.database.collection("rooms").findOne({ id: roomId });
    return room ? room.id : null;
  }
  async getParticipantsForAccount(userId) {
    await this.ensureConnection();
    return await this.database.collection("participants").find({ userId }).toArray();
  }
  async getParticipantsForRoom(roomId) {
    await this.ensureConnection();
    const participants = await this.database.collection("participants").find({ roomId }).toArray();
    return participants.map((p) => p.userId);
  }
  async getParticipantUserState(roomId, userId) {
    await this.ensureConnection();
    const participant = await this.database.collection("participants").findOne({ roomId, userId });
    return (participant == null ? void 0 : participant.userState) ?? null;
  }
  async setParticipantUserState(roomId, userId, state) {
    await this.ensureConnection();
    await this.database.collection("participants").updateOne(
      { roomId, userId },
      { $set: { userState: state } }
    );
  }
  async getAccountById(userId) {
    await this.ensureConnection();
    const account = await this.database.collection("accounts").findOne({ id: userId });
    if (!account) return null;
    return {
      ...account,
      details: typeof account.details === "string" ? JSON.parse(account.details) : account.details
    };
  }
  async createAccount(account) {
    await this.ensureConnection();
    try {
      await this.database.collection("accounts").insertOne({
        ...account,
        id: account.id ?? v4(),
        details: JSON.stringify(account.details),
        createdAt: /* @__PURE__ */ new Date()
      });
      return true;
    } catch (error) {
      console.error("Error creating account:", error);
      return false;
    }
  }
  async getActorDetails(params) {
    await this.ensureConnection();
    const actors = await this.database.collection("participants").aggregate([
      { $match: { roomId: params.roomId } },
      {
        $lookup: {
          from: "accounts",
          localField: "userId",
          foreignField: "id",
          as: "account"
        }
      },
      { $unwind: "$account" },
      {
        $project: {
          id: "$account.id",
          name: "$account.name",
          username: "$account.username",
          details: "$account.details"
        }
      }
    ]).toArray();
    return actors.map((actor) => ({
      ...actor,
      details: typeof actor.details === "string" ? JSON.parse(actor.details) : actor.details
    })).filter((actor) => actor !== null);
  }
  async getMemoriesByRoomIds(params) {
    await this.ensureConnection();
    if (!params.tableName) {
      params.tableName = "messages";
    }
    const memories = await this.database.collection("memories").find({
      type: params.tableName,
      agentId: params.agentId,
      roomId: { $in: params.roomIds }
    }).toArray();
    return memories.map((memory) => ({
      ...memory,
      content: typeof memory.content === "string" ? JSON.parse(memory.content) : memory.content
    }));
  }
  async getMemoryById(memoryId) {
    await this.ensureConnection();
    const memory = await this.database.collection("memories").findOne({ id: memoryId });
    if (!memory) return null;
    return {
      ...memory,
      content: typeof memory.content === "string" ? JSON.parse(memory.content) : memory.content
    };
  }
  async createMemory(memory, tableName) {
    await this.ensureConnection();
    try {
      let isUnique = true;
      if (memory.embedding) {
        const similarMemories = await this.searchMemories(
          {
            tableName,
            roomId: memory.roomId,
            agentId: memory.agentId,
            embedding: memory.embedding,
            match_threshold: 0.95,
            match_count: 1,
            unique: isUnique
          }
        );
        isUnique = similarMemories.length === 0;
      }
      const content = JSON.stringify(memory.content);
      const createdAt = memory.createdAt ?? Date.now();
      await this.database.collection("memories").insertOne({
        id: memory.id ?? v4(),
        type: tableName,
        content,
        embedding: memory.embedding ? Array.from(memory.embedding) : null,
        userId: memory.userId,
        roomId: memory.roomId,
        agentId: memory.agentId,
        unique: isUnique,
        createdAt: new Date(createdAt)
      });
    } catch (e) {
      elizaLogger.error(e);
    }
  }
  async searchMemoriesFallback(params) {
    await this.ensureConnection();
    const memories = await this.database.collection("memories").find(params.query).limit(params.limit || 10).toArray();
    return memories.map((memory) => ({
      ...memory,
      similarity: this.cosineSimilarity(params.embedding, memory.embedding)
    })).sort((a, b) => b.similarity - a.similarity).map((memory) => ({
      ...memory,
      createdAt: typeof memory.createdAt === "string" ? Date.parse(memory.createdAt) : memory.createdAt,
      content: typeof memory.content === "string" ? JSON.parse(memory.content) : memory.content
    }));
  }
  cosineSimilarity(a, b) {
    const aArr = Array.from(a);
    const bArr = Array.from(b);
    const dotProduct = aArr.reduce((sum, val, i) => sum + val * bArr[i], 0);
    const magnitudeA = Math.sqrt(aArr.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(bArr.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitudeA * magnitudeB);
  }
  async searchMemories(params) {
    await this.ensureConnection();
    const query = {
      type: params.tableName,
      roomId: params.roomId,
      ...params.unique && { unique: true },
      ...params.agentId && { agentId: params.agentId }
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
              index: "vector_index"
            }
          }
        },
        { $match: query }
      ];
      try {
        const memories = await this.database.collection("memories").aggregate(pipeline).toArray();
        return memories.map((memory) => ({
          ...memory,
          createdAt: typeof memory.createdAt === "string" ? Date.parse(memory.createdAt) : memory.createdAt,
          content: typeof memory.content === "string" ? JSON.parse(memory.content) : memory.content
        }));
      } catch (error) {
        console.log("Vector search failed, falling back to standard search", error);
        return this.searchMemoriesFallback({
          embedding: params.embedding,
          query,
          limit: params.match_count
        });
      }
    }
    return this.searchMemoriesFallback({
      embedding: params.embedding,
      query,
      limit: params.match_count
    });
  }
  async searchMemoriesByEmbedding(embedding, params) {
    await this.ensureConnection();
    const pipeline = [
      {
        $search: {
          vectorSearch: {
            queryVector: Array.from(embedding),
            path: "embedding",
            numCandidates: (params.count ?? 10) * 2,
            limit: params.count,
            index: "vector_index"
          }
        }
      },
      {
        $match: {
          type: params.tableName,
          agentId: params.agentId,
          ...params.unique && { unique: true },
          ...params.roomId && { roomId: params.roomId }
        }
      }
    ];
    const memories = await this.database.collection("memories").aggregate(pipeline).toArray();
    return memories.map((memory) => ({
      ...memory,
      createdAt: typeof memory.createdAt === "string" ? Date.parse(memory.createdAt) : memory.createdAt,
      content: typeof memory.content === "string" ? JSON.parse(memory.content) : memory.content
    }));
  }
  async getCachedEmbeddings(opts) {
    await this.ensureConnection();
    const BATCH_SIZE = 1e3;
    let results = [];
    try {
      const totalCount = await this.database.collection("memories").countDocuments({
        type: opts.query_table_name,
        [`content.${opts.query_field_name}.${opts.query_field_sub_name}`]: { $exists: true }
      });
      let processed = 0;
      while (processed < totalCount) {
        const memories = await this.database.collection("memories").find({
          type: opts.query_table_name,
          [`content.${opts.query_field_name}.${opts.query_field_sub_name}`]: { $exists: true }
        }).skip(processed).limit(BATCH_SIZE).toArray();
        const batchResults = memories.map((memory) => {
          try {
            const content = memory.content[opts.query_field_name][opts.query_field_sub_name];
            if (!content || typeof content !== "string") {
              return null;
            }
            return {
              embedding: Array.from(memory.embedding),
              levenshtein_score: this.calculateLevenshteinDistanceOptimized(
                content.toLowerCase(),
                opts.query_input.toLowerCase()
              )
            };
          } catch (error) {
            console.warn(`Error processing memory document: ${error}`);
            return null;
          }
        }).filter((result) => result !== null);
        results = this.mergeAndSortResults(results, batchResults, opts.query_match_count);
        processed += memories.length;
        if (totalCount > BATCH_SIZE) {
          console.log(`Processed ${processed}/${totalCount} documents`);
        }
      }
      return results;
    } catch (error) {
      console.error("Error in getCachedEmbeddings:", error);
      if (results.length > 0) {
        console.log("Returning partial results");
        return results;
      }
      return [];
    }
  }
  /**
   * Optimized Levenshtein distance calculation with early termination
   * and matrix reuse for better performance
   */
  calculateLevenshteinDistanceOptimized(str1, str2) {
    if (str1 === str2) return 0;
    if (str1.length === 0) return str2.length;
    if (str2.length === 0) return str1.length;
    if (str1.length > str2.length) {
      [str1, str2] = [str2, str1];
    }
    const matrix = this.getLevenshteinMatrix(str1.length + 1, str2.length + 1);
    for (let i = 0; i <= str1.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= str2.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= str1.length; i++) {
      for (let j = 1; j <= str2.length; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            // substitution
            matrix[i][j - 1] + 1,
            // insertion
            matrix[i - 1][j] + 1
            // deletion
          );
        }
      }
    }
    return matrix[str1.length][str2.length];
  }
  getLevenshteinMatrix(rows, cols) {
    const size = rows * cols;
    if (size > this.maxMatrixSize) {
      this.levenshteinMatrix = Array(rows).fill(null).map(() => Array(cols).fill(0));
      this.maxMatrixSize = size;
    }
    return this.levenshteinMatrix;
  }
  /**
   * Efficiently merge and sort two arrays of results while maintaining top K items
   */
  mergeAndSortResults(existing, newResults, limit) {
    const merged = [...existing, ...newResults];
    if (merged.length > 1e3) {
      return this.quickSelectTopK(merged, limit);
    }
    return merged.sort((a, b) => a.levenshtein_score - b.levenshtein_score).slice(0, limit);
  }
  /**
   * Quick select algorithm to efficiently find top K items
   */
  quickSelectTopK(arr, k) {
    if (arr.length <= k) return arr.sort((a, b) => a.levenshtein_score - b.levenshtein_score);
    const pivot = arr[Math.floor(Math.random() * arr.length)].levenshtein_score;
    const left = arr.filter((x) => x.levenshtein_score < pivot);
    const equal = arr.filter((x) => x.levenshtein_score === pivot);
    const right = arr.filter((x) => x.levenshtein_score > pivot);
    if (k <= left.length) {
      return this.quickSelectTopK(left, k);
    }
    if (k <= left.length + equal.length) {
      return [...left, ...equal.slice(0, k - left.length)].sort((a, b) => a.levenshtein_score - b.levenshtein_score);
    }
    return [...left, ...equal, ...this.quickSelectTopK(right, k - left.length - equal.length)].sort((a, b) => a.levenshtein_score - b.levenshtein_score);
  }
  async updateGoalStatus(params) {
    await this.ensureConnection();
    await this.database.collection("goals").updateOne(
      { id: params.goalId },
      { $set: { status: params.status } }
    );
  }
  async log(params) {
    await this.ensureConnection();
    await this.database.collection("logs").insertOne({
      id: v4(),
      body: JSON.stringify(params.body),
      userId: params.userId,
      roomId: params.roomId,
      type: params.type,
      createdAt: /* @__PURE__ */ new Date()
    });
  }
  async getMemories(params) {
    await this.ensureConnection();
    if (!params.tableName) {
      throw new Error("tableName is required");
    }
    if (!params.roomId) {
      throw new Error("roomId is required");
    }
    const query = {
      type: params.tableName,
      agentId: params.agentId,
      roomId: params.roomId
    };
    if (params.unique) {
      query.unique = true;
    }
    if (params.start || params.end) {
      query.createdAt = {};
      if (params.start) query.createdAt.$gte = new Date(params.start);
      if (params.end) query.createdAt.$lte = new Date(params.end);
    }
    const memories = await this.database.collection("memories").find(query).sort({ createdAt: -1 }).limit(params.count || 0).toArray();
    return memories.map((memory) => ({
      ...memory,
      createdAt: new Date(memory.createdAt).getTime(),
      content: typeof memory.content === "string" ? JSON.parse(memory.content) : memory.content
    }));
  }
  async removeMemory(memoryId, tableName) {
    await this.ensureConnection();
    await this.database.collection("memories").deleteOne({
      id: memoryId,
      type: tableName
    });
  }
  async removeAllMemories(roomId, tableName) {
    await this.ensureConnection();
    await this.database.collection("memories").deleteMany({
      roomId,
      type: tableName
    });
  }
  async countMemories(roomId, unique = true, tableName = "") {
    await this.ensureConnection();
    if (!tableName) {
      throw new Error("tableName is required");
    }
    const query = {
      type: tableName,
      roomId
    };
    if (unique) {
      query.unique = true;
    }
    return await this.database.collection("memories").countDocuments(query);
  }
  async getGoals(params) {
    await this.ensureConnection();
    const query = { roomId: params.roomId };
    if (params.userId) {
      query.userId = params.userId;
    }
    if (params.onlyInProgress) {
      query.status = "IN_PROGRESS";
    }
    const goals = await this.database.collection("goals").find(query).limit(params.count || 0).toArray();
    return goals.map((goal) => ({
      ...goal,
      objectives: typeof goal.objectives === "string" ? JSON.parse(goal.objectives) : goal.objectives
    }));
  }
  async updateGoal(goal) {
    await this.ensureConnection();
    await this.database.collection("goals").updateOne(
      { id: goal.id },
      {
        $set: {
          name: goal.name,
          status: goal.status,
          objectives: JSON.stringify(goal.objectives)
        }
      }
    );
  }
  async createGoal(goal) {
    await this.ensureConnection();
    await this.database.collection("goals").insertOne({
      ...goal,
      id: goal.id ?? v4(),
      objectives: JSON.stringify(goal.objectives),
      createdAt: /* @__PURE__ */ new Date()
    });
  }
  async removeGoal(goalId) {
    await this.ensureConnection();
    await this.database.collection("goals").deleteOne({ id: goalId });
  }
  async removeAllGoals(roomId) {
    await this.ensureConnection();
    await this.database.collection("goals").deleteMany({ roomId });
  }
  async createRoom(roomId) {
    await this.ensureConnection();
    const newRoomId = roomId || v4();
    try {
      await this.database.collection("rooms").insertOne({
        id: newRoomId,
        createdAt: /* @__PURE__ */ new Date()
      });
      return newRoomId;
    } catch (error) {
      console.error("Error creating room:", error);
      throw error;
    }
  }
  async removeRoom(roomId) {
    await this.ensureConnection();
    try {
      await this.database.collection("rooms").deleteOne({ id: roomId });
    } catch (error) {
      console.error("Error removing room:", error);
      throw error;
    }
  }
  async getRoomsForParticipant(userId) {
    await this.ensureConnection();
    const rooms = await this.database.collection("participants").find({ userId }).project({ roomId: 1 }).toArray();
    return rooms.map((r) => r.roomId);
  }
  async getRoomsForParticipants(userIds) {
    await this.ensureConnection();
    const rooms = await this.database.collection("participants").distinct("roomId", { userId: { $in: userIds } });
    return rooms;
  }
  async addParticipant(userId, roomId) {
    await this.ensureConnection();
    try {
      await this.database.collection("participants").insertOne({
        id: v4(),
        userId,
        roomId,
        createdAt: /* @__PURE__ */ new Date()
      });
      return true;
    } catch (error) {
      console.log("Error adding participant", error);
      return false;
    }
  }
  async removeParticipant(userId, roomId) {
    await this.ensureConnection();
    try {
      await this.database.collection("participants").deleteOne({
        userId,
        roomId
      });
      return true;
    } catch (error) {
      console.log("Error removing participant", error);
      return false;
    }
  }
  async createRelationship(params) {
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
        createdAt: /* @__PURE__ */ new Date()
      });
      return true;
    } catch (error) {
      console.log("Error creating relationship", error);
      return false;
    }
  }
  async getRelationship(params) {
    await this.ensureConnection();
    return await this.database.collection("relationships").findOne({
      $or: [
        { userA: params.userA, userB: params.userB },
        { userA: params.userB, userB: params.userA }
      ]
    });
  }
  async getRelationships(params) {
    await this.ensureConnection();
    return await this.database.collection("relationships").find({
      $or: [
        { userA: params.userId },
        { userB: params.userId }
      ]
    }).toArray();
  }
  async getCache(params) {
    await this.ensureConnection();
    const cached = await this.database.collection("cache").findOne({
      key: params.key,
      agentId: params.agentId,
      expiresAt: { $gt: /* @__PURE__ */ new Date() }
    });
    return cached == null ? void 0 : cached.value;
  }
  async setCache(params) {
    await this.ensureConnection();
    try {
      await this.database.collection("cache").updateOne(
        { key: params.key, agentId: params.agentId },
        {
          $set: {
            value: params.value,
            createdAt: /* @__PURE__ */ new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1e3)
            // 24 hours expiry
          }
        },
        { upsert: true }
      );
      return true;
    } catch (error) {
      console.log("Error setting cache", error);
      return false;
    }
  }
  async deleteCache(params) {
    await this.ensureConnection();
    try {
      await this.database.collection("cache").deleteOne({
        key: params.key,
        agentId: params.agentId
      });
      return true;
    } catch (error) {
      console.log("Error removing cache", error);
      return false;
    }
  }
  async getKnowledge(params) {
    await this.ensureConnection();
    const query = {
      $or: [
        { agentId: params.agentId },
        { isShared: true }
      ]
    };
    if (params.id) {
      query.id = params.id;
    }
    const knowledge = await this.database.collection("knowledge").find(query).limit(params.limit || 0).toArray();
    return knowledge.map((item) => ({
      id: item.id,
      agentId: item.agentId,
      content: typeof item.content === "string" ? JSON.parse(item.content) : item.content,
      embedding: item.embedding ? new Float32Array(item.embedding) : void 0,
      createdAt: typeof item.createdAt === "string" ? Date.parse(item.createdAt) : item.createdAt
    }));
  }
  async searchKnowledge(params) {
    await this.ensureConnection();
    const cacheKey = `embedding_${params.agentId}_${params.searchText}`;
    const cachedResult = await this.getCache({
      key: cacheKey,
      agentId: params.agentId
    });
    if (cachedResult) {
      return JSON.parse(cachedResult);
    }
    try {
      let results;
      if (this.hasVectorSearch) {
        try {
          results = await this.vectorSearchKnowledge(params);
        } catch (error) {
          console.log("Vector search failed, falling back to standard search", error);
          results = await this.fallbackSearchKnowledge(params);
        }
      } else {
        results = await this.fallbackSearchKnowledge(params);
      }
      const mappedResults = results.map((item) => ({
        id: item.id,
        agentId: item.agentId,
        // This will always be UUID
        content: typeof item.content === "string" ? JSON.parse(item.content) : item.content,
        embedding: item.embedding ? new Float32Array(item.embedding) : void 0,
        createdAt: typeof item.createdAt === "string" ? Date.parse(item.createdAt) : item.createdAt,
        similarity: item.combinedScore || 0
      }));
      await this.setCache({
        key: cacheKey,
        agentId: params.agentId,
        value: JSON.stringify(mappedResults)
      });
      return mappedResults;
    } catch (error) {
      console.error("Error in searchKnowledge:", error);
      throw error;
    }
  }
  async vectorSearchKnowledge(params) {
    const pipeline = [
      {
        $search: {
          vectorSearch: {
            queryVector: Array.from(params.embedding),
            path: "embedding",
            numCandidates: params.match_count * 2,
            limit: params.match_count * 2,
            index: "vector_index"
          }
        }
      },
      ...this.getKnowledgeSearchPipeline(params)
    ];
    return await this.database.collection("knowledge").aggregate(pipeline).toArray();
  }
  async fallbackSearchKnowledge(params) {
    const pipeline = [
      {
        $match: {
          $or: [
            { agentId: params.agentId },
            { isShared: true, agentId: null }
          ]
        }
      },
      ...this.getKnowledgeSearchPipeline(params)
    ];
    return await this.database.collection("knowledge").aggregate(pipeline).toArray();
  }
  getKnowledgeSearchPipeline(params) {
    return [
      {
        $addFields: {
          vectorScore: this.hasVectorSearch ? { $meta: "vectorSearchScore" } : {
            $let: {
              vars: {
                embedding: { $ifNull: ["$embedding", []] }
              },
              in: {
                $cond: [
                  { $eq: [{ $size: "$$embedding" }, 0] },
                  0,
                  {
                    $divide: [
                      1,
                      { $add: [1, { $function: {
                        body: this.cosineSimilarity.toString(),
                        args: [params.embedding, "$$embedding"],
                        lang: "js"
                      } }] }
                    ]
                  }
                ]
              }
            }
          },
          keywordScore: this.calculateKeywordScore(params.searchText)
        }
      },
      {
        $addFields: {
          combinedScore: { $multiply: ["$vectorScore", "$keywordScore"] }
        }
      },
      {
        $match: {
          $or: [
            { vectorScore: { $gte: params.match_threshold } },
            {
              $and: [
                { keywordScore: { $gt: 1 } },
                { vectorScore: { $gte: 0.3 } }
              ]
            }
          ]
        }
      },
      { $sort: { combinedScore: -1 } }
    ];
  }
  calculateKeywordScore(searchText) {
    return {
      $multiply: [
        {
          $cond: [
            searchText ? {
              $regexMatch: {
                input: { $toLower: "$content.text" },
                regex: new RegExp(searchText.toLowerCase())
              }
            } : false,
            3,
            1
          ]
        },
        {
          $cond: [
            { $eq: ["$content.metadata.isChunk", true] },
            1.5,
            {
              $cond: [
                { $eq: ["$content.metadata.isMain", true] },
                1.2,
                1
              ]
            }
          ]
        }
      ]
    };
  }
  // Update error handling in createKnowledge
  async createKnowledge(knowledge) {
    var _a;
    await this.ensureConnection();
    try {
      const metadata = knowledge.content.metadata || {};
      const isShared = metadata.isShared || false;
      const doc = {
        id: knowledge.id,
        agentId: knowledge.agentId,
        content: typeof knowledge.content === "string" ? knowledge.content : JSON.stringify(knowledge.content),
        embedding: knowledge.embedding ? Array.from(knowledge.embedding) : null,
        createdAt: knowledge.createdAt || Date.now(),
        isMain: metadata.isMain || false,
        originalId: metadata.originalId || null,
        chunkIndex: metadata.chunkIndex || null,
        isShared
      };
      await this.database.collection("knowledge").updateOne(
        { id: knowledge.id },
        { $setOnInsert: doc },
        { upsert: true }
      );
    } catch (err) {
      if (err instanceof Error) {
        const error = err;
        const isShared = (_a = knowledge.content.metadata) == null ? void 0 : _a.isShared;
        if (isShared && error.code === 11e3) {
          console.info(`Shared knowledge ${knowledge.id} already exists, skipping`);
          return;
        }
        console.error(`Error creating knowledge ${knowledge.id}:`, error);
        throw error;
      }
      throw err;
    }
  }
  async removeKnowledge(id) {
    await this.ensureConnection();
    await this.database.collection("knowledge").deleteOne({ id });
  }
  async clearKnowledge(agentId, shared) {
    await this.ensureConnection();
    const query = shared ? { $or: [{ agentId }, { isShared: true }] } : { agentId };
    try {
      await this.database.collection("knowledge").deleteMany(query);
    } catch (error) {
      console.error(`Error clearing knowledge for agent ${agentId}:`, error);
      throw error;
    }
  }
  async getMemoriesByIds(memoryIds, tableName) {
    await this.ensureConnection();
    const collection = tableName || "memories";
    try {
      const memories = await this.database.collection(collection).find({ id: { $in: memoryIds } }).toArray();
      return memories.map((memory) => ({
        id: memory.id,
        roomId: memory.roomId,
        agentId: memory.agentId,
        type: memory.type,
        content: memory.content,
        embedding: memory.embedding,
        createdAt: memory.createdAt instanceof Date ? memory.createdAt.getTime() : memory.createdAt,
        metadata: memory.metadata || {}
      }));
    } catch (error) {
      elizaLogger.error("Failed to get memories by IDs:", error);
      return [];
    }
  }
};
export {
  MongoDBDatabaseAdapter
};
//# sourceMappingURL=index.js.map