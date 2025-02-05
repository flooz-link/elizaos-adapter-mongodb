import { MongoClient } from 'mongodb';
import { DatabaseAdapter, IDatabaseCacheAdapter, UUID, Participant, Account, Actor, Memory, GoalStatus, Goal, Relationship, RAGKnowledgeItem } from '@elizaos/core';

declare class MongoDBDatabaseAdapter extends DatabaseAdapter<MongoClient> implements IDatabaseCacheAdapter {
    private database;
    private databaseName;
    private hasVectorSearch;
    private isConnected;
    private isVectorSearchIndexComputable;
    db: MongoClient;
    constructor(client: MongoClient, databaseName: string);
    private initializeCollections;
    private initializeStandardIndexes;
    private initializeVectorSearch;
    private createStandardEmbeddingIndexes;
    init(): Promise<void>;
    close(): Promise<void>;
    private ensureConnection;
    getRoom(roomId: UUID): Promise<UUID | null>;
    getParticipantsForAccount(userId: UUID): Promise<Participant[]>;
    getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;
    getParticipantUserState(roomId: UUID, userId: UUID): Promise<"FOLLOWED" | "MUTED" | null>;
    setParticipantUserState(roomId: UUID, userId: UUID, state: "FOLLOWED" | "MUTED" | null): Promise<void>;
    getAccountById(userId: UUID): Promise<Account | null>;
    createAccount(account: Account): Promise<boolean>;
    getActorDetails(params: {
        roomId: UUID;
    }): Promise<Actor[]>;
    getMemoriesByRoomIds(params: {
        agentId: UUID;
        roomIds: UUID[];
        tableName: string;
    }): Promise<Memory[]>;
    getMemoryById(memoryId: UUID): Promise<Memory | null>;
    createMemory(memory: Memory, tableName: string): Promise<void>;
    private searchMemoriesFallback;
    private cosineSimilarity;
    searchMemories(params: {
        tableName: string;
        roomId: UUID;
        agentId?: UUID;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]>;
    searchMemoriesByEmbedding(embedding: number[], params: {
        match_threshold?: number;
        count?: number;
        roomId?: UUID;
        agentId: UUID;
        unique?: boolean;
        tableName: string;
    }): Promise<Memory[]>;
    getCachedEmbeddings(opts: {
        query_table_name: string;
        query_threshold: number;
        query_input: string;
        query_field_name: string;
        query_field_sub_name: string;
        query_match_count: number;
    }): Promise<{
        embedding: number[];
        levenshtein_score: number;
    }[]>;
    /**
     * Optimized Levenshtein distance calculation with early termination
     * and matrix reuse for better performance
     */
    private calculateLevenshteinDistanceOptimized;
    private levenshteinMatrix;
    private maxMatrixSize;
    private getLevenshteinMatrix;
    /**
     * Efficiently merge and sort two arrays of results while maintaining top K items
     */
    private mergeAndSortResults;
    /**
     * Quick select algorithm to efficiently find top K items
     */
    private quickSelectTopK;
    updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void>;
    log(params: {
        body: {
            [key: string]: unknown;
        };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void>;
    getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
        agentId: UUID;
        start?: number;
        end?: number;
    }): Promise<Memory[]>;
    removeMemory(memoryId: UUID, tableName: string): Promise<void>;
    removeAllMemories(roomId: UUID, tableName: string): Promise<void>;
    countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number>;
    getGoals(params: {
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]>;
    updateGoal(goal: Goal): Promise<void>;
    createGoal(goal: Goal): Promise<void>;
    removeGoal(goalId: UUID): Promise<void>;
    removeAllGoals(roomId: UUID): Promise<void>;
    createRoom(roomId?: UUID): Promise<UUID>;
    removeRoom(roomId: UUID): Promise<void>;
    getRoomsForParticipant(userId: UUID): Promise<UUID[]>;
    getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]>;
    addParticipant(userId: UUID, roomId: UUID): Promise<boolean>;
    removeParticipant(userId: UUID, roomId: UUID): Promise<boolean>;
    createRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<boolean>;
    getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null>;
    getRelationships(params: {
        userId: UUID;
    }): Promise<Relationship[]>;
    getCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<string | undefined>;
    setCache(params: {
        key: string;
        agentId: UUID;
        value: string;
    }): Promise<boolean>;
    deleteCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<boolean>;
    getKnowledge(params: {
        id?: UUID;
        agentId: UUID;
        limit?: number;
        query?: string;
    }): Promise<RAGKnowledgeItem[]>;
    searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array;
        match_threshold: number;
        match_count: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]>;
    private vectorSearchKnowledge;
    private fallbackSearchKnowledge;
    private getKnowledgeSearchPipeline;
    private calculateKeywordScore;
    createKnowledge(knowledge: RAGKnowledgeItem): Promise<void>;
    removeKnowledge(id: UUID): Promise<void>;
    clearKnowledge(agentId: UUID, shared?: boolean): Promise<void>;
    getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]>;
}

export { MongoDBDatabaseAdapter };
