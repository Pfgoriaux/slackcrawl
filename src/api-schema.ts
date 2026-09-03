// Machine-readable OpenAPI schema served unauthenticated at /v1/schema
// (agent discovery). Kept out of api.ts to respect the file-size convention.

export function openApiSchema() {
  return {
    openapi: "3.0.3",
    info: {
      title: "slackcrawl",
      version: "0.2.0",
      description:
        "Slack archive REST API for AI agents. Mirrors public + private channels into SQLite with optional AI enrichment.",
    },
    paths: {
      "/health": {
        get: {
          summary: "Liveness check (body includes `ready` once the first sync completes)",
          security: [],
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/search": {
        get: {
          summary: "Search messages (keyword, semantic, or hybrid)",
          parameters: [
            {
              name: "q",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "mode",
              in: "query",
              schema: {
                type: "string",
                enum: ["keyword", "semantic", "hybrid"],
                default: "keyword",
              },
            },
            { name: "channel", in: "query", schema: { type: "string" } },
            { name: "author", in: "query", schema: { type: "string" } },
            {
              name: "since",
              in: "query",
              schema: { type: "string", format: "date" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 50 },
            },
            {
              name: "include_threads",
              in: "query",
              schema: { type: "boolean" },
            },
          ],
        },
      },
      "/v1/messages": {
        get: {
          summary: "Query messages with filters",
          parameters: [
            { name: "channel", in: "query", schema: { type: "string" } },
            {
              name: "days",
              in: "query",
              schema: { type: "integer", default: 7 },
            },
            { name: "hours", in: "query", schema: { type: "integer" } },
            { name: "author", in: "query", schema: { type: "string" } },
            {
              name: "since",
              in: "query",
              schema: { type: "string", format: "date" },
            },
            {
              name: "until",
              in: "query",
              schema: { type: "string", format: "date" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 100 },
            },
            {
              name: "include_threads",
              in: "query",
              schema: { type: "boolean" },
            },
          ],
        },
      },
      "/v1/threads": {
        get: {
          summary: "Get thread by timestamp",
          parameters: [
            {
              name: "channel",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "thread_ts",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
        },
      },
      "/v1/channels": {
        get: {
          summary: "List channels",
          parameters: [{ name: "archived", in: "query", schema: { type: "boolean" } }],
        },
      },
      "/v1/members": {
        get: {
          summary: "Search members",
          parameters: [{ name: "query", in: "query", schema: { type: "string" } }],
        },
      },
      "/v1/status": { get: { summary: "DB and enrichment statistics" } },
      "/v1/sync": {
        post: {
          summary: "Trigger background sync",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    channel: { type: "string" },
                    full: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/context": {
        get: {
          summary: "Bundled context for agents — the main endpoint",
          parameters: [
            {
              name: "topic",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
            { name: "channel", in: "query", schema: { type: "string" } },
            {
              name: "days",
              in: "query",
              schema: { type: "integer", default: 14 },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 10 },
            },
          ],
        },
      },
      "/v1/decisions": {
        get: {
          summary: "Query extracted decisions and action items",
          parameters: [
            { name: "channel", in: "query", schema: { type: "string" } },
            {
              name: "since",
              in: "query",
              schema: { type: "string", format: "date" },
            },
            { name: "q", in: "query", schema: { type: "string" } },
            {
              name: "category",
              in: "query",
              schema: {
                type: "string",
                enum: ["decision", "action_item", "conclusion", "commitment"],
              },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 50 },
            },
          ],
        },
      },
      "/v1/digests": {
        get: {
          summary: "Query daily channel digests",
          parameters: [
            { name: "channel", in: "query", schema: { type: "string" } },
            {
              name: "days",
              in: "query",
              schema: { type: "integer", default: 7 },
            },
            {
              name: "date",
              in: "query",
              schema: { type: "string", format: "date" },
            },
          ],
        },
      },
      "/v1/expertise": {
        get: {
          summary: "Search expertise profiles or get user profile",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "user", in: "query", schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 20 },
            },
          ],
        },
      },
      "/v1/enrich": { post: { summary: "Trigger enrichment pipeline" } },
    },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
      },
    },
    security: [{ bearer: [] }],
  };
}
