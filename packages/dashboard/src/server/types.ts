export interface ApiStatus {
  agentFingerprint: string;
  agentDisplayName?: string;
  peersOnline: number;
  peersTotal: number;
  stateCount: number;
  uptime: number;
}

export interface ApiPeer {
  fingerprint: string;
  displayName?: string;
  online: boolean;
  lastSeen: number;
  trusted: boolean;
}

export interface ApiState {
  id: string;
  name: string;
  memberCount: number;
  lastActivity: number;
  selfMd?: string;
  isPublic: boolean;
}

export interface ApiStateMember {
  fingerprint: string;
  displayName?: string;
  role: string;
}

export interface ApiStateMessage {
  id: string;
  senderFingerprint?: string;
  senderName?: string;
  content: string;
  timestamp: number;
}

export interface ApiStateDetail {
  id: string;
  name: string;
  memberCount: number;
  lastActivity: number;
  selfMd?: string;
  isPublic: boolean;
  members: ApiStateMember[];
  messages: ApiStateMessage[];
}
