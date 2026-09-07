import { createHash } from "node:crypto";
import type { ApiPeer, ApiState } from "./types.js";

export interface PublicPeerPermission {
  label: string;
  publishFingerprint?: boolean;
}
export interface PublicPublicationConfig {
  observerLabel?: string;
  stateIds?: string[];
  stateContextIds?: string[];
  peers?: Record<string, PublicPeerPermission>;
}
export interface PublicNetworkObservation {
  schemaVersion: 1;
  source: "public-node";
  observedAt: string;
  node: { id: string; name: string };
  states: {
    id: string;
    name: string;
    isPublic: true;
    memberCount: number | null;
    selfMd: string | null;
  }[];
  peers: { id: string; name: string; online: boolean | null }[];
  links: [];
  coverage: {
    scope: "one-observer";
    publication: "explicit-allowlist";
    counts: "published-records-only";
    topology: "not-exposed-by-inspected-api";
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 160;

/** Operator-only configuration. Raw fingerprints must never enter the browser bundle. */
export function validatePublicPublicationConfig(
  raw: unknown = {},
): PublicPublicationConfig {
  if (!isRecord(raw))
    throw new Error("Public publication config must be an object.");
  for (const key of ["stateIds", "stateContextIds"] as const) {
    if (
      raw[key] !== undefined &&
      (!Array.isArray(raw[key]) || !(raw[key] as unknown[]).every(isId))
    ) {
      throw new Error(
        `${key} must contain exact nonempty IDs of at most 160 characters.`,
      );
    }
  }
  if (
    raw.observerLabel !== undefined &&
    (typeof raw.observerLabel !== "string" || !raw.observerLabel.trim())
  ) {
    throw new Error("observerLabel must be a nonempty approved label.");
  }
  if (raw.peers !== undefined && !isRecord(raw.peers))
    throw new Error(
      "peers must map exact fingerprints to publication options.",
    );
  const peers: Record<string, PublicPeerPermission> = Object.create(null);
  for (const [id, permission] of Object.entries(raw.peers ?? {})) {
    if (
      !isId(id) ||
      !isRecord(permission) ||
      typeof permission.label !== "string" ||
      !permission.label.trim()
    ) {
      throw new Error(
        "Each published peer requires an exact fingerprint and an explicit label.",
      );
    }
    if (
      permission.publishFingerprint !== undefined &&
      typeof permission.publishFingerprint !== "boolean"
    ) {
      throw new Error("publishFingerprint must be a boolean.");
    }
    peers[id] = {
      label: permission.label.slice(0, 100),
      publishFingerprint: permission.publishFingerprint === true,
    };
  }
  return {
    observerLabel:
      typeof raw.observerLabel === "string"
        ? raw.observerLabel.slice(0, 100)
        : "this node",
    stateIds: [...((raw.stateIds as string[]) ?? [])],
    stateContextIds: [...((raw.stateContextIds as string[]) ?? [])],
    peers,
  };
}

/** Builds a new allowlisted DTO; never reads state details, messages, or private context. */
export function buildPublicObservation(
  raw: { states: ApiState[]; peers: ApiPeer[]; observedAt?: string },
  config: PublicPublicationConfig = {},
): PublicNetworkObservation {
  const cfg = validatePublicPublicationConfig(config);
  if (!raw || !Array.isArray(raw.states) || !Array.isArray(raw.peers)) {
    throw new Error("Incomplete observation; refusing an empty substitute.");
  }
  const observedAt = raw.observedAt ?? new Date().toISOString();
  if (
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt)) ||
    Date.parse(observedAt) > Date.now() + 60_000
  ) {
    throw new Error("Invalid observation timestamp.");
  }
  const allowed = new Set(cfg.stateIds);
  const context = new Set(cfg.stateContextIds);
  // A stale discovery copy must not republish an ID now marked private by the node.
  const privateIds = new Set(
    raw.states
      .filter((state) => state && state.isPublic !== true)
      .map((state) => state.id),
  );
  const states = new Map<string, PublicNetworkObservation["states"][number]>();
  for (const state of raw.states) {
    if (
      !state ||
      !isId(state.id) ||
      state.isPublic !== true ||
      privateIds.has(state.id) ||
      !allowed.has(state.id)
    )
      continue;
    states.set(state.id, {
      id: state.id,
      name:
        typeof state.name === "string" ? state.name.slice(0, 100) : state.id,
      isPublic: true,
      memberCount:
        Number.isSafeInteger(state.memberCount) && state.memberCount >= 0
          ? state.memberCount
          : null,
      // Withhold oversized originals instead of silently presenting an excerpt as a full policy.
      selfMd:
        context.has(state.id) &&
        typeof state.selfMd === "string" &&
        state.selfMd.length <= 6000
          ? state.selfMd
          : null,
    });
  }
  const peers = new Map<string, PublicNetworkObservation["peers"][number]>();
  for (const peer of raw.peers) {
    if (
      !peer ||
      !isId(peer.fingerprint) ||
      !Object.hasOwn(cfg.peers ?? {}, peer.fingerprint)
    )
      continue;
    const permission = cfg.peers![peer.fingerprint];
    const id =
      permission.publishFingerprint === true
        ? peer.fingerprint
        : `peer-${createHash("sha256").update(peer.fingerprint).digest("hex").slice(0, 16)}`;
    peers.set(id, {
      id,
      name: permission.label,
      online: typeof peer.online === "boolean" ? peer.online : null,
    });
  }
  if (states.size > 1000 || peers.size > 1000)
    throw new Error("Publication exceeds the 1,000-record observation limit.");
  return {
    schemaVersion: 1,
    source: "public-node",
    observedAt,
    node: { id: "observer", name: cfg.observerLabel! },
    states: [...states.values()],
    peers: [...peers.values()],
    links: [],
    coverage: {
      scope: "one-observer",
      publication: "explicit-allowlist",
      counts: "published-records-only",
      topology: "not-exposed-by-inspected-api",
    },
  };
}
