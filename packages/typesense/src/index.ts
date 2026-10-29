export {
  TYPESENSE_READ_CAPABILITIES,
  type TypesenseCapabilityDescriptor,
  type TypesenseConfiguredBounds,
  type TypesenseQueryBounds,
  type TypesenseReadCapabilities,
} from "./capabilities.js";
export {
  TypesenseContinuationBoundError,
  TypesenseCursorError,
  TypesenseHttpError,
  TypesenseRequestError,
  TypesenseResponseSizeError,
  TypesenseSemanticError,
  type TypesenseMetadataFailure,
} from "./errors.js";
export { TypesenseJsonNumberError } from "./json.js";
export {
  TypesenseDatabase,
  type TypesenseConnectionTest,
  type TypesenseDatabaseOptions,
  type TypesenseDescribe,
} from "./database.js";
export type {
  TypesenseCollectionDiscovery,
  TypesenseCollectionSchema,
  TypesenseFieldDefinition,
  TypesenseSchemaDiscovery,
} from "./metadata.js";
export {
  buildNativeResult,
  decodeSearchResponse,
  type TypesenseFacet,
  type TypesenseFacetStats,
  type TypesenseFacetValue,
  type TypesenseNativeSearchHit,
  type TypesenseNativeSearchRequest,
  type TypesenseNativeSearchResult,
  type TypesenseSort,
} from "./search.js";
export type {
  ComparisonNode,
  ConditionNode,
  FilterLiteral,
  GroupNode,
  Truth,
  TypesenseQuery,
} from "./structured.js";
export type {
  TypesenseFetch,
  TypesenseHeaderProvider,
  TypesenseHeaders,
} from "./transport.js";
