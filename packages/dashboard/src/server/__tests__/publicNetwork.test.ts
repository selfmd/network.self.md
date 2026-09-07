import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildPublicObservation,
  validatePublicPublicationConfig,
} from "../publicNetwork.js";
import type { ApiPeer, ApiState } from "../types.js";

const state = (id: string, overrides: Partial<ApiState> = {}): ApiState => ({
  id,
  name: "Shared Name",
  memberCount: 2,
  lastActivity: 123,
  isPublic: true,
  selfMd: "# Private until approved",
  ...overrides,
});
const peer = (
  fingerprint: string,
  overrides: Partial<ApiPeer> = {},
): ApiPeer => ({
  fingerprint,
  displayName: "Unapproved name",
  online: true,
  lastSeen: 123,
  trusted: true,
  ...overrides,
});

describe("public observation publication boundary", () => {
  it("denies all records and context by default", () => {
    const result = buildPublicObservation({
      states: [state("ab")],
      peers: [peer("cd")],
    });
    expect(result.states).toEqual([]);
    expect(result.peers).toEqual([]);
    expect(result.links).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Unapproved");
  });
  it("requires separate context consent and denies private records even when allowlisted", () => {
    const raw = {
      states: [state("ab"), state("cd", { isPublic: false })],
      peers: [],
    };
    expect(
      buildPublicObservation(raw, { stateIds: ["ab", "cd"] }).states,
    ).toEqual([
      {
        id: "ab",
        name: "Shared Name",
        memberCount: 2,
        isPublic: true,
        selfMd: null,
      },
    ]);
    const result = buildPublicObservation(raw, {
      stateIds: ["ab", "cd"],
      stateContextIds: ["ab", "cd"],
    });
    expect(result.states[0].selfMd).toBe("# Private until approved");
    expect(result.states).toHaveLength(1);
  });
  it("deduplicates by ID, keeps distinct names, and blocks conflicting private copies", () => {
    const result = buildPublicObservation(
      {
        states: [
          state("ab"),
          state("cd"),
          state("ab", { memberCount: 4 }),
          state("ef"),
          state("ef", { isPublic: false }),
        ],
        peers: [],
      },
      { stateIds: ["ab", "cd", "ef"] },
    );
    expect(result.states.map((value) => value.id)).toEqual(["ab", "cd"]);
    expect(result.states[0].memberCount).toBe(4);
  });
  it("publishes approved labels with deterministic pseudonyms and explicit raw ID opt-in", () => {
    const raw = {
      states: [],
      peers: [peer("ab"), peer("ab"), peer("cd"), peer("ef")],
    };
    const result = buildPublicObservation(raw, {
      peers: {
        ab: { label: "Ray" },
        cd: { label: "Another agent", publishFingerprint: true },
      },
    });
    expect(result.peers).toEqual([
      {
        id:
          "peer-" +
          createHash("sha256").update("ab").digest("hex").slice(0, 16),
        name: "Ray",
        online: true,
      },
      { id: "cd", name: "Another agent", online: true },
    ]);
    expect(JSON.stringify(result)).not.toContain("trusted");
    expect(JSON.stringify(result)).not.toContain("lastSeen");
  });
  it("withholds oversized context and strips unapproved state detail fields", () => {
    const detailed = {
      ...state("ab", {
        selfMd: "x".repeat(6001),
        memberCount: Number.MAX_SAFE_INTEGER + 1,
      }),
      messages: ["secret"],
      privateKey: "secret",
    };
    const result = buildPublicObservation(
      { states: [detailed], peers: [] },
      { stateIds: ["ab"], stateContextIds: ["ab"] },
    );
    expect(result.states[0].selfMd).toBeNull();
    expect(result.states[0].memberCount).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("preserves read-start timestamps and rejects invalid or future captures", () => {
    const observedAt = "2020-01-01T00:00:00.000Z";
    expect(
      buildPublicObservation({ states: [], peers: [], observedAt }).observedAt,
    ).toBe(observedAt);
    expect(() =>
      buildPublicObservation({
        states: [],
        peers: [],
        observedAt: "not a date",
      }),
    ).toThrow();
    expect(() =>
      buildPublicObservation({
        states: [],
        peers: [],
        observedAt: new Date(Date.now() + 120_000).toISOString(),
      }),
    ).toThrow();
  });
  it("rejects malformed consent and refuses incomplete observations", () => {
    expect(() => validatePublicPublicationConfig({ stateIds: [""] })).toThrow();
    expect(() =>
      validatePublicPublicationConfig({ peers: { ab: { label: " " } } }),
    ).toThrow();
    expect(() =>
      validatePublicPublicationConfig({
        peers: { ab: { label: "Ray", publishFingerprint: "true" } },
      }),
    ).toThrow();
    expect(() =>
      buildPublicObservation({ states: [] } as unknown as Parameters<
        typeof buildPublicObservation
      >[0]),
    ).toThrow();
    const inherited = Object.create({ ab: { label: "inherited" } });
    expect(
      buildPublicObservation(
        { states: [], peers: [peer("ab")] },
        { peers: inherited },
      ).peers,
    ).toEqual([]);
  });
});
