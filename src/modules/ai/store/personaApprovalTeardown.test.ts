import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Audit M1 (2026-11-01, docs/2.1.2-group-chat-review.md): teardown paths
 * (endGroupChat / deleteGroupChat / removeParticipant) must DENY pending
 * persona approval cards. A card parks the run at
 * `await Promise.all(decisionPromises)` — the aborter sweep alone never
 * resolves it, so a teardown without the sweep leaks the run forever and
 * leaves a phantom GroupPill badge.
 *
 * Behavioral test: a mocked generateText parks the real run at a real card;
 * the teardown must (a) clear getPersonaApprovals() and (b) resolve the run
 * — proven by the run's SECOND generateText call carrying the
 * tool-approval-response with approved:false.
 */

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeLazyStore {
    private map = new Map<string, unknown>();
    async get() {
      return null;
    }
    async set(key: string, value: unknown) {
      this.map.set(key, value);
    }
    async save() {}
  }
  return { LazyStore: FakeLazyStore };
});

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));

// generateText is the park/resume seam; everything else in `ai` stays real
// (stepCountIs etc.).
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: generateTextMock };
});

// personaWorkspaceRoot needs homeDir(), which needs Tauri (absent in tests).
// Mock the path module so the persona scratch root resolves to a fake home.
vi.mock("@tauri-apps/api/path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/path")>();
  return { ...actual, homeDir: async () => "C:/Users/test" };
});

vi.mock("../lib/agent", () => ({
  buildLanguageModel: vi.fn(async () => ({
    provider: "test",
    modelId: "test",
  })),
}));

const injectMessageMock = vi.fn();
const activeSessions: Record<string, string | null> = {};
const personaTestState: {
  selectedModelId?: string;
  apiKeys?: Record<string, string>;
} = {};
vi.mock("./chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatStore")>();
  return {
    ...actual,
    useChatStore: {
      getState: () => ({
        injectMessage: injectMessageMock,
        selectedModelId: personaTestState.selectedModelId,
        apiKeys: personaTestState.apiKeys,
      }),
    },
    getSessionAgentMeta: () => ({ status: "idle" }),
    getProjectActiveSession: (id: string) => activeSessions[id] ?? null,
  };
});

import { getModel, DEFAULT_MODEL_ID } from "../config";
import {
  __resetGroupChatsForTest,
  addPersonaParticipants,
  createGroupChat,
  deleteGroupChat,
  endGroupChat,
  getGroup,
  getPersonaApprovals,
  removeParticipant,
  sendGroupMessage,
} from "./groupChatStore";

const PERSONA = "persona:builtin:reviewer";

/** A generateText result that parks the run at one approval card. */
function parkedResult(toolCallId: string, approvalId: string) {
  return {
    text: "I need to run a command first.",
    response: {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool-approval-request", toolCallId, approvalId },
          ],
        },
      ],
    },
    steps: [
      {
        toolCalls: [
          { toolCallId, toolName: "bash_run", input: { command: "echo hi" } },
        ],
        toolResults: [],
      },
    ],
  };
}

/** A generateText result with no pending calls — lets the run finish. */
function cleanFinish(text: string) {
  return {
    text,
    response: { messages: [] },
    steps: [{ toolCalls: [], toolResults: [] }],
  };
}

async function until(
  cond: () => boolean,
  label: string,
  ms = 4_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(cond(), label).toBe(true);
}

/** Park a persona run at an approval card in a fresh group. */
async function parkAtCard(
  approvalId: string,
): Promise<{ groupId: string; toolCallId: string }> {
  const toolCallId = `tc-${approvalId}`;
  generateTextMock
    .mockResolvedValueOnce(parkedResult(toolCallId, approvalId) as never)
    .mockResolvedValue(cleanFinish("done") as never);
  const g = await createGroupChat(
    { projectId: "a", sessionId: "s1", root: "/a", name: "alpha" },
    [{ projectId: "b", root: "/b", name: "beta" }],
  );
  await addPersonaParticipants(g!.id, ["builtin:reviewer"]);
  const m = getModel(DEFAULT_MODEL_ID);
  personaTestState.selectedModelId = DEFAULT_MODEL_ID;
  personaTestState.apiKeys = { [m.provider]: "test-key" };
  await sendGroupMessage(g!.id, "please review");
  await until(
    () => getPersonaApprovals().length === 1,
    "approval card should be registered",
  );
  expect(getPersonaApprovals()[0]!.approvalId).toBe(approvalId);
  return { groupId: g!.id, toolCallId };
}

/** The run's resume round must carry the denial — the parked run resolved. */
function assertRunResumedWithDenial(approvalId: string, toolCallId: string) {
  expect(generateTextMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  const resumeArgs = generateTextMock.mock.calls[1]![0] as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const denyMsg = resumeArgs.messages.find((m) => m.role === "tool");
  expect(denyMsg).toBeDefined();
  const parts = denyMsg!.content as Array<{
    type?: string;
    approvalId?: string;
    approved?: boolean;
  }>;
  expect(parts).toEqual([
    { type: "tool-approval-response", approvalId, approved: false },
  ]);
  void toolCallId;
}

beforeEach(() => {
  __resetGroupChatsForTest();
  injectMessageMock.mockReset();
  generateTextMock.mockReset();
  activeSessions["a"] = "active-a";
  activeSessions["b"] = "active-b";
});

describe("teardown denies parked persona approval cards (audit M1)", () => {
  it("endGroupChat denies the card and the run resumes as denied", async () => {
    const { groupId, toolCallId } = await parkAtCard("ap-end");
    await endGroupChat(groupId);
    expect(getPersonaApprovals()).toHaveLength(0);
    await until(
      () => generateTextMock.mock.calls.length >= 2,
      "run must resume after denial",
    );
    assertRunResumedWithDenial("ap-end", toolCallId);
    // The group is ended, not deleted.
    expect(getGroup(groupId)?.endedAt).not.toBeNull();
  });

  it("deleteGroupChat denies the card and the run resumes as denied", async () => {
    const { groupId, toolCallId } = await parkAtCard("ap-del");
    await deleteGroupChat(groupId);
    expect(getPersonaApprovals()).toHaveLength(0);
    await until(
      () => generateTextMock.mock.calls.length >= 2,
      "run must resume after denial",
    );
    assertRunResumedWithDenial("ap-del", toolCallId);
    expect(getGroup(groupId)).toBeNull();
  });

  it("removeParticipant denies the card and the run resumes as denied", async () => {
    const { groupId, toolCallId } = await parkAtCard("ap-rm");
    await removeParticipant(groupId, PERSONA);
    expect(getPersonaApprovals()).toHaveLength(0);
    await until(
      () => generateTextMock.mock.calls.length >= 2,
      "run must resume after denial",
    );
    assertRunResumedWithDenial("ap-rm", toolCallId);
    expect(
      getGroup(groupId)!.participants.some((x) => x.projectId === PERSONA),
    ).toBe(false);
  });

  it("an unrelated session's cards survive (suffix match, not a wipe)", async () => {
    const { groupId } = await parkAtCard("ap-keep");
    // Teardown for a session with no persona cards must not disturb the
    // parked card of another session.
    await endGroupChat("not-a-real-group");
    void groupId;
    // The parked card from parkAtCard is still registered.
    expect(getPersonaApprovals()).toHaveLength(1);
    // Clean up so the parked run does not leak into other tests.
    await endGroupChat(groupId);
    expect(getPersonaApprovals()).toHaveLength(0);
  });
});
