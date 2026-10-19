import { workerDatabaseUrl } from "../../../packages/db/test/test-db";

// Each test worker runs on its own copy of the API test database.
process.env.TEST_DATABASE_URL = workerDatabaseUrl(process.env.TEST_DATABASE_URL!);
