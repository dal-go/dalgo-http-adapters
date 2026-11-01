// Separate upstream diagnostic. A failure here is never called an adapter DOM
// pass, and never permits Node globals or skipLibCheck in browser.ts above.
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDbDocumentClientLike } from "@dal-go/dalgo2dynamodb";
declare const official: DynamoDBDocumentClient;
const assignment: DynamoDbDocumentClientLike = official;
// @ts-expect-error Probe whether direct SDK declarations introduce Node Buffer.
type VendorForbiddenBuffer = typeof Buffer;
// @ts-expect-error Probe whether direct SDK declarations introduce Node process.
type VendorForbiddenProcess = typeof process;
// @ts-expect-error Probe whether direct SDK declarations introduce NodeJS.
type VendorForbiddenNamespace = NodeJS.Process;
void assignment;
