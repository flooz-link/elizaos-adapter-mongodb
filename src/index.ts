import { mongoDBAdapter, MongoDBDatabaseAdapter } from "./client";

const mongodbPlugin = {
  name: "mongodb",
  description: "MongoDB database adapter plugin",
  adapters: [mongoDBAdapter],
};

export {
  mongodbPlugin,
  MongoDBDatabaseAdapter,
  MongoDBDatabaseAdapter as default,
};
