// Temporary mock server for README screenshots and GIF capture
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 9876;
const CONTENT_DIR = path.join(__dirname, ".github/extensions/agent-observer/content");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

// ── Helpers ────────────────────────────────────────────────────────────────
function mkNode(key, parentKey, children) {
  return { key, parentKey, children };
}

function mkGraph(nodes) {
  const nodeParentKeys = {};
  const childNodeKeys = {};
  const pathNodeKeys = {};
  const descendantCounts = {};

  for (const n of nodes) {
    nodeParentKeys[n.key] = n.parentKey;
    childNodeKeys[n.key] = n.children;
  }

  function buildPath(key) {
    if (pathNodeKeys[key]) return pathNodeKeys[key];
    const parent = nodeParentKeys[key];
    const parentPath = parent ? buildPath(parent) : [];
    pathNodeKeys[key] = [...parentPath, key];
    return pathNodeKeys[key];
  }

  function countDesc(key) {
    if (descendantCounts[key] !== undefined) return descendantCounts[key];
    const kids = childNodeKeys[key] || [];
    let count = kids.length;
    for (const kid of kids) count += countDesc(kid);
    descendantCounts[key] = count;
    return count;
  }

  for (const n of nodes) buildPath(n.key);
  for (const n of nodes) countDesc(n.key);

  return {
    rootNodeKey: "root:__root__",
    nodeParentKeys,
    childNodeKeys,
    pathNodeKeys,
    descendantCounts,
    orphanNodeKeys: [],
    hiddenToolCallIds: [],
  };
}

// ── Rich sample data with dynamic timestamps ─────────────────────────────
// Scenario: Agent Observer inspecting a code review + test run session
// All timestamps are relative to "now" so running agents show realistic durations
const NOW = Date.now();
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

const subagents = [
  { id: "sa-explore", agentName: "explore-codebase", agentDisplayName: "explore-codebase", agentType: "explore", status: "completed", description: "Analyze repository structure and find key modules", prompt: "Explore the codebase to understand the auth module architecture", model: "claude-haiku-4", startedAt: ago(195), completedAt: ago(158), parentToolCallId: "__root__", _lastEventTs: ago(158) },
  { id: "sa-review", agentName: "code-review", agentDisplayName: "code-review", agentType: "general-purpose", status: "completed", description: "Review PR #47 changes for security issues", prompt: "Review the auth middleware changes in PR #47 for security vulnerabilities and best practices", model: "claude-sonnet-4", startedAt: ago(152), completedAt: ago(65), parentToolCallId: "__root__", _lastEventTs: ago(65) },
  { id: "sa-test", agentName: "run-tests", agentDisplayName: "run-tests", agentType: "task", status: "completed", description: "Execute test suite and report results", prompt: "Run the full test suite including auth integration tests", model: "claude-haiku-4", startedAt: ago(60), completedAt: ago(10), parentToolCallId: "__root__", _lastEventTs: ago(10) },
  { id: "sa-fix", agentName: "apply-fix", agentDisplayName: "apply-fix", agentType: "general-purpose", status: "started", description: "Apply suggested security fixes", prompt: "Fix the JWT token validation bypass identified in the review", model: "claude-sonnet-4", startedAt: ago(5), completedAt: null, parentToolCallId: "__root__", _lastEventTs: ago(2) },
];

const toolCalls = [
  // Root-level tools
  { id: "tc-r1", toolName: "grep", status: "complete", parentToolCallId: "__root__", startedAt: ago(199), completedAt: ago(197), arguments: { pattern: "authenticate|authorize", paths: ["src/"] }, resultPreview: "Found 14 matches across 6 files:\nsrc/middleware/auth.ts:12\nsrc/middleware/auth.ts:45\nsrc/routes/login.ts:8\n...", _lastEventTs: ago(197) },
  { id: "tc-r2", toolName: "view", status: "complete", parentToolCallId: "__root__", startedAt: ago(197), completedAt: ago(196), arguments: { path: "src/middleware/auth.ts" }, resultPreview: "import jwt from 'jsonwebtoken';\nimport { Request, Response, NextFunction } from 'express';\n\nexport function verifyToken(req: Request, res: Response, next: NextFunction) {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) return res.status(401).json({ error: 'No token' });\n  ...", _lastEventTs: ago(196) },

  // Explore agent tools
  { id: "tc-e1", toolName: "glob", status: "complete", parentToolCallId: "sa-explore", startedAt: ago(192), completedAt: ago(191), arguments: { pattern: "src/**/*.ts" }, resultPreview: "42 files matched:\nsrc/app.ts\nsrc/middleware/auth.ts\nsrc/middleware/rate-limit.ts\nsrc/routes/login.ts\nsrc/routes/users.ts\n...", _lastEventTs: ago(191) },
  { id: "tc-e2", toolName: "view", status: "complete", parentToolCallId: "sa-explore", startedAt: ago(190), completedAt: ago(189), arguments: { path: "package.json" }, resultPreview: '{ "name": "auth-service", "version": "2.1.0", "dependencies": { "express": "^4.18", "jsonwebtoken": "^9.0", "bcrypt": "^5.1" } }', _lastEventTs: ago(189) },
  { id: "tc-e3", toolName: "grep", status: "complete", parentToolCallId: "sa-explore", startedAt: ago(185), completedAt: ago(184), arguments: { pattern: "jwt\\.verify|jwt\\.sign", paths: ["src/"] }, resultPreview: "src/middleware/auth.ts:18: jwt.verify(token, SECRET)\nsrc/routes/login.ts:32: jwt.sign(payload, SECRET, { expiresIn: '24h' })", _lastEventTs: ago(184) },
  { id: "tc-e4", toolName: "view", status: "complete", parentToolCallId: "sa-explore", startedAt: ago(180), completedAt: ago(179), arguments: { path: "src/routes/login.ts" }, resultPreview: "import bcrypt from 'bcrypt';\nimport jwt from 'jsonwebtoken';\n\nrouter.post('/login', async (req, res) => {\n  const { email, password } = req.body;\n  const user = await User.findByEmail(email);\n  if (!user || !await bcrypt.compare(password, user.hash)) {\n    return res.status(401).json({ error: 'Invalid credentials' });\n  }\n  const token = jwt.sign({ sub: user.id, role: user.role }, SECRET);\n  res.json({ token });\n});", _lastEventTs: ago(179) },

  // Code review agent tools
  { id: "tc-cr1", toolName: "grep", status: "complete", parentToolCallId: "sa-review", startedAt: ago(148), completedAt: ago(147), arguments: { pattern: "algorithm|HS256|RS256", paths: ["src/"] }, resultPreview: "No matches found — JWT algorithm is not explicitly set", _lastEventTs: ago(147) },
  { id: "tc-cr2", toolName: "view", status: "complete", parentToolCallId: "sa-review", startedAt: ago(145), completedAt: ago(144), arguments: { path: "src/middleware/auth.ts", view_range: [15, 30] }, resultPreview: "15: export function verifyToken(req, res, next) {\n16:   const token = req.headers.authorization?.split(' ')[1];\n17:   if (!token) return res.status(401).json({ error: 'No token' });\n18:   const decoded = jwt.verify(token, SECRET);\n19:   req.user = decoded;\n20:   next();\n21: }", _lastEventTs: ago(144) },
  { id: "tc-cr3", toolName: "grep", status: "complete", parentToolCallId: "sa-review", startedAt: ago(140), completedAt: ago(139), arguments: { pattern: "SECRET|process\\.env", paths: ["src/"] }, resultPreview: "src/config.ts:3: export const SECRET = process.env.JWT_SECRET || 'dev-secret';\nsrc/middleware/auth.ts:2: import { SECRET } from '../config';", _lastEventTs: ago(139) },
  { id: "tc-cr4", toolName: "view", status: "complete", parentToolCallId: "sa-review", startedAt: ago(130), completedAt: ago(129), arguments: { path: "src/config.ts" }, resultPreview: "export const SECRET = process.env.JWT_SECRET || 'dev-secret';\nexport const PORT = parseInt(process.env.PORT || '3000');\nexport const DB_URL = process.env.DATABASE_URL || 'postgres://localhost/auth';", _lastEventTs: ago(129) },
  { id: "tc-cr5", toolName: "view", status: "complete", parentToolCallId: "sa-review", startedAt: ago(100), completedAt: ago(99), arguments: { path: "tests/auth.test.ts" }, resultPreview: "describe('auth middleware', () => {\n  it('rejects missing token', async () => { ... });\n  it('rejects expired token', async () => { ... });\n  it('passes valid token', async () => { ... });\n  // Missing: algorithm confusion test\n  // Missing: token reuse after password change\n});", _lastEventTs: ago(99) },

  // Test agent tools
  { id: "tc-t1", toolName: "powershell", status: "complete", parentToolCallId: "sa-test", startedAt: ago(58), completedAt: ago(25), arguments: { command: "npm test -- --reporter=verbose" }, resultPreview: "PASS tests/auth.test.ts (8 tests)\nPASS tests/routes.test.ts (12 tests)\nPASS tests/middleware.test.ts (6 tests)\nFAIL tests/integration.test.ts\n  ✗ token refresh flow (AssertionError: expected 200, got 401)\n\nTests: 25 passed, 1 failed, 26 total\nTime: 32.4s", _lastEventTs: ago(25) },
  { id: "tc-t2", toolName: "view", status: "complete", parentToolCallId: "sa-test", startedAt: ago(22), completedAt: ago(21), arguments: { path: "tests/integration.test.ts", view_range: [45, 65] }, resultPreview: "45: it('token refresh flow', async () => {\n46:   const res1 = await request(app).post('/login').send(creds);\n47:   const { token } = res1.body;\n48:   await sleep(500);\n49:   const res2 = await request(app).post('/refresh').set('Authorization', `Bearer ${token}`);\n50:   expect(res2.status).toBe(200);  // Fails: refresh endpoint missing\n51: });", _lastEventTs: ago(21) },

  // Fix agent tools (in-progress)
  { id: "tc-f1", toolName: "view", status: "complete", parentToolCallId: "sa-fix", startedAt: ago(4), completedAt: ago(3), arguments: { path: "src/middleware/auth.ts" }, resultPreview: "...", _lastEventTs: ago(3) },
  { id: "tc-f2", toolName: "edit", status: "running", parentToolCallId: "sa-fix", startedAt: ago(2), completedAt: null, arguments: { path: "src/middleware/auth.ts", old_str: "jwt.verify(token, SECRET)", new_str: "jwt.verify(token, SECRET, { algorithms: ['HS256'] })" }, resultPreview: null, _lastEventTs: ago(2) },
];

const messages = [
  { id: "msg-1", role: "assistant", content: "I'll start by exploring the codebase to understand the auth architecture, then do a security review of PR #47.", parentToolCallId: "__root__", timestamp: ago(200), reasoning: null, _lastEventTs: ago(200) },
  { id: "msg-2", role: "assistant", content: "Found the auth module structure. The JWT implementation uses a shared secret from config.ts with a hardcoded fallback. I see 42 TypeScript files across the service.", parentToolCallId: "sa-explore", timestamp: ago(160), reasoning: "The codebase follows a standard Express.js pattern with middleware-based auth. Key concern: the jwt.verify() call doesn't specify an algorithm, which could allow algorithm confusion attacks.", _lastEventTs: ago(160) },
  { id: "msg-3", role: "assistant", content: "Security review complete. Found 3 issues:\n1. **Critical**: jwt.verify() doesn't specify algorithm — vulnerable to algorithm confusion\n2. **High**: Hardcoded fallback secret 'dev-secret' in config.ts\n3. **Medium**: No test coverage for algorithm confusion or token reuse after password change", parentToolCallId: "sa-review", timestamp: ago(70), reasoning: "The algorithm confusion vulnerability is the most critical finding. An attacker could forge tokens by switching from HS256 to 'none' or using a public key as HMAC secret.", _lastEventTs: ago(70) },
  { id: "msg-4", role: "assistant", content: "Test results: 25/26 passing. The failing test is the token refresh flow — the /refresh endpoint doesn't exist yet. This is a pre-existing issue unrelated to PR #47.", parentToolCallId: "sa-test", timestamp: ago(12), reasoning: null, _lastEventTs: ago(12) },
  { id: "msg-5", role: "assistant", content: "Applying the algorithm fix to jwt.verify() — adding explicit { algorithms: ['HS256'] } to prevent algorithm confusion attacks.", parentToolCallId: "sa-fix", timestamp: ago(3), reasoning: "Starting with the critical fix. The HS256 algorithm specification prevents both 'none' algorithm bypass and RS256/HS256 confusion attacks.", _lastEventTs: ago(3) },
];

const toolCallsByParent = {
  "__root__": [
    { toolCallId: "tc-r1", toolName: "grep", status: "complete" },
    { toolCallId: "tc-r2", toolName: "view", status: "complete" },
  ],
  "sa-explore": [
    { toolCallId: "tc-e1", toolName: "glob", status: "complete" },
    { toolCallId: "tc-e2", toolName: "view", status: "complete" },
    { toolCallId: "tc-e3", toolName: "grep", status: "complete" },
    { toolCallId: "tc-e4", toolName: "view", status: "complete" },
  ],
  "sa-review": [
    { toolCallId: "tc-cr1", toolName: "grep", status: "complete" },
    { toolCallId: "tc-cr2", toolName: "view", status: "complete" },
    { toolCallId: "tc-cr3", toolName: "grep", status: "complete" },
    { toolCallId: "tc-cr4", toolName: "view", status: "complete" },
    { toolCallId: "tc-cr5", toolName: "view", status: "complete" },
  ],
  "sa-test": [
    { toolCallId: "tc-t1", toolName: "powershell", status: "complete" },
    { toolCallId: "tc-t2", toolName: "view", status: "complete" },
  ],
  "sa-fix": [
    { toolCallId: "tc-f1", toolName: "view", status: "complete" },
    { toolCallId: "tc-f2", toolName: "edit", status: "running" },
  ],
};

const allToolIds = toolCalls.map(t => t.id);
const graphNodes = [
  mkNode("root:__root__", null, ["subagent:sa-explore", "subagent:sa-review", "subagent:sa-test", "subagent:sa-fix", "tool:tc-r1", "tool:tc-r2"]),
  mkNode("subagent:sa-explore", "root:__root__", ["tool:tc-e1", "tool:tc-e2", "tool:tc-e3", "tool:tc-e4"]),
  mkNode("subagent:sa-review", "root:__root__", ["tool:tc-cr1", "tool:tc-cr2", "tool:tc-cr3", "tool:tc-cr4", "tool:tc-cr5"]),
  mkNode("subagent:sa-test", "root:__root__", ["tool:tc-t1", "tool:tc-t2"]),
  mkNode("subagent:sa-fix", "root:__root__", ["tool:tc-f1", "tool:tc-f2"]),
  ...allToolIds.map(id => mkNode(`tool:${id}`, null, [])), // parents set below
];
// Fix tool parent keys
const toolParentMap = {};
for (const tc of toolCalls) {
  const parent = tc.parentToolCallId === "__root__" ? "root:__root__" : `subagent:${tc.parentToolCallId}`;
  toolParentMap[`tool:${tc.id}`] = parent;
}
for (const n of graphNodes) {
  if (n.key.startsWith("tool:") && toolParentMap[n.key]) {
    n.parentKey = toolParentMap[n.key];
  }
}

const executionGraph = mkGraph(graphNodes);

const timeline = [
  { kind: "message", id: "msg-1" },
  { kind: "toolcall", id: "tc-r1" },
  { kind: "toolcall", id: "tc-r2" },
  { kind: "subagent", id: "sa-explore" },
  { kind: "toolcall", id: "tc-e1" },
  { kind: "toolcall", id: "tc-e2" },
  { kind: "toolcall", id: "tc-e3" },
  { kind: "toolcall", id: "tc-e4" },
  { kind: "message", id: "msg-2" },
  { kind: "subagent", id: "sa-review" },
  { kind: "toolcall", id: "tc-cr1" },
  { kind: "toolcall", id: "tc-cr2" },
  { kind: "toolcall", id: "tc-cr3" },
  { kind: "toolcall", id: "tc-cr4" },
  { kind: "toolcall", id: "tc-cr5" },
  { kind: "message", id: "msg-3" },
  { kind: "subagent", id: "sa-test" },
  { kind: "toolcall", id: "tc-t1" },
  { kind: "toolcall", id: "tc-t2" },
  { kind: "message", id: "msg-4" },
  { kind: "subagent", id: "sa-fix" },
  { kind: "toolcall", id: "tc-f1" },
  { kind: "toolcall", id: "tc-f2" },
  { kind: "message", id: "msg-5" },
];

const ACTIVE_SNAPSHOT = JSON.stringify({
  stats: {
    subagentCount: subagents.length,
    toolCallCount: toolCalls.length,
    messageCount: messages.length,
    ingestedEventCount: 38,
    orphanToolCallCount: 0,
  },
  subagents,
  toolCalls,
  messages,
  toolCallsByParent,
  recentEvents: [
    { ts: ago(2), type: "tool.execution_start", summary: "edit started on src/middleware/auth.ts" },
    { ts: ago(3), type: "assistant.message", summary: "apply-fix: Applying the algorithm fix..." },
    { ts: ago(10), type: "subagent.completed", summary: "run-tests completed" },
  ],
  timeline,
  executionGraph,
});

let currentSnapshot = ACTIVE_SNAPSHOT;

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    let html = fs.readFileSync(path.join(CONTENT_DIR, "index.html"), "utf-8");
    const mockScript = `<script>
      window.copilot = {
        getSnapshot: () => fetch("/api/snapshot").then(r => r.text()),
        showNotification: (msg) => console.log("[notification]", msg),
      };
    </script>`;
    html = html.replace("</head>", mockScript + "</head>");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  if (req.url === "/api/snapshot") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(currentSnapshot);
    return;
  }

  const filePath = path.join(CONTENT_DIR, req.url);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(fs.readFileSync(filePath));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => console.log(`Mock server at http://localhost:${PORT}`));
