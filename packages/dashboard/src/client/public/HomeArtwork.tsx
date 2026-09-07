// Geometry and authored examples faithfully transferred from the approved v2.2 handoff.

export function ExchangeArtwork() {
  return (
    <svg viewBox="0 0 560 485" role="img" aria-labelledby="heroArtTitle">
      <title id="heroArtTitle">
        a message moves between two independently owned agent systems
      </title>
      <defs>
        <pattern id="dots" width="19" height="19" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r=".7" fill="#aaa69c" opacity=".4" />
        </pattern>
        <pattern
          id="hatch"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="6" stroke="#0c0d0e" strokeWidth="1" />
        </pattern>
        <clipPath id="heroClip">
          <rect x="0" y="0" width="560" height="450" />
        </clipPath>
      </defs>
      <g clipPath="url(#heroClip)">
        <rect x="6" y="20" width="548" height="415" fill="url(#dots)" />
        <path
          d="M8 41V25H24M536 25H552V41M8 414V430H24M536 430H552V414"
          fill="none"
          stroke="#0c0d0e"
        />
        <text x="24" y="56" className="svg-mono" fontSize="9">
          a conversation, not a data merger.
        </text>
        <text
          x="537"
          y="413"
          textAnchor="end"
          className="svg-mono"
          fontSize="8"
        >
          two separate systems
        </text>
        <path
          d="M188 234C222 234 285 275 316 275"
          fill="none"
          stroke="#0c0d0e"
          strokeWidth="1.5"
          strokeDasharray="3 5"
        />
        <g id="heroLeft">
          <path
            d="M33 286L161 210L263 269L135 345Z"
            fill="#d6d2c8"
            stroke="#0c0d0e"
          />
          <path d="M33 286V301L135 360V345Z" fill="#0c0d0e" />
          <path
            d="M135 345V360L263 284V269Z"
            fill="url(#hatch)"
            stroke="#0c0d0e"
          />
          <path
            d="M50 231L155 171L239 220L134 280Z"
            fill="#fff"
            stroke="#0c0d0e"
            strokeWidth="1.3"
          />
          <path d="M50 231V251L134 300V280Z" fill="#0c0d0e" />
          <path d="M134 280V300L239 240V220Z" fill="#e4e0d5" stroke="#0c0d0e" />
          <path
            d="M50 218L155 158L239 207L134 267Z"
            fill="#fff"
            stroke="#0c0d0e"
            strokeWidth="1.3"
          />
          <g transform="translate(85 221) rotate(-30) skewX(30)">
            <text y="0" fontFamily="var(--mono)" fontSize="12" fontWeight="700">
              self.md
            </text>
            <line x1="0" y1="10" x2="61" y2="10" stroke="#0c0d0e" />
            <line x1="0" y1="16" x2="45" y2="16" stroke="#0c0d0e" />
          </g>
          <path
            d="M89 140L153 103L204 133L140 170Z"
            fill="#ff1484"
            stroke="#0c0d0e"
            strokeWidth="1.3"
          />
          <path d="M89 140V180L140 210V170Z" fill="#0c0d0e" />
          <path d="M140 170V210L204 173V133Z" fill="#c70e64" stroke="#0c0d0e" />
          <text
            x="147"
            y="146"
            textAnchor="middle"
            className="svg-mono"
            fontSize="18"
            fontWeight="700"
          >
            [!]
          </text>
          <path d="M50 180V92H83" fill="none" stroke="#0c0d0e" />
          <text x="88" y="96" className="svg-mono" fontSize="11">
            you
          </text>
          <text x="85" y="372" className="svg-mono" fontSize="9">
            your agent / your context
          </text>
        </g>
        <g id="heroRight">
          <path
            d="M284 317L412 243L518 304L389 378Z"
            fill="#d6d2c8"
            stroke="#0c0d0e"
          />
          <path d="M284 317V332L389 393V378Z" fill="#0c0d0e" />
          <path
            d="M389 378V393L518 319V304Z"
            fill="url(#hatch)"
            stroke="#0c0d0e"
          />
          <path
            d="M300 265L411 201L499 252L388 316Z"
            fill="#fff"
            stroke="#0c0d0e"
            strokeWidth="1.3"
          />
          <path d="M300 265V282L388 333V316Z" fill="#0c0d0e" />
          <path d="M388 316V333L499 269V252Z" fill="#dcd8cc" stroke="#0c0d0e" />
          <path
            d="M300 252L411 188L499 239L388 303Z"
            fill="#fff"
            stroke="#0c0d0e"
            strokeWidth="1.3"
          />
          <g transform="translate(336 256) rotate(-30) skewX(30)">
            <text y="0" className="svg-mono" fontSize="12" fontWeight="700">
              self.md
            </text>
            <line x1="0" y1="10" x2="67" y2="10" stroke="#0c0d0e" />
            <line x1="0" y1="16" x2="49" y2="16" stroke="#0c0d0e" />
          </g>
          <path
            d="M344 168L408 131L459 161L395 198Z"
            fill="#f8f6f0"
            stroke="#0c0d0e"
            strokeWidth="1.3"
          />
          <path d="M344 168V210L395 240V198Z" fill="#0c0d0e" />
          <path d="M395 198V240L459 203V161Z" fill="#8f9088" stroke="#0c0d0e" />
          <text
            x="402"
            y="174"
            textAnchor="middle"
            className="svg-mono"
            fontSize="18"
            fontWeight="700"
          >
            [!]
          </text>
          <path d="M492 189V112H455" fill="none" stroke="#0c0d0e" />
          <text
            x="446"
            y="115"
            textAnchor="end"
            className="svg-mono"
            fontSize="11"
          >
            Ray
          </text>
        </g>
        <g id="heroMessage">
          <path
            d="M0 0H70L80 10V49H0Z"
            fill="#ff1484"
            stroke="#0c0d0e"
            strokeWidth="1.2"
          />
          <path d="M70 0V10H80" fill="none" stroke="#0c0d0e" />
          <text
            x="9"
            y="19"
            className="svg-mono"
            fontSize="8"
            id="heroMessageText"
          >
            hello.md
          </text>
          <path d="M10 28H57M10 34H44" stroke="#0c0d0e" />
          <text x="63" y="40" className="svg-mono" fontSize="15">
            ↗
          </text>
        </g>
        <text
          id="heroExchange"
          x="281"
          y="89"
          textAnchor="middle"
          className="svg-mono"
          fontSize="9"
        >
          01 / say hello
        </text>
      </g>
    </svg>
  );
}

export function DirectDesktopArtwork() {
  return (
    <svg
      className="desktop-scene"
      viewBox="0 0 1000 355"
      role="img"
      aria-label="two agent terminals exchange an illustrated message"
    >
      <g id="p2pLeft">
        <rect x="108" y="61" width="250" height="210" fill="#0c0d0e" />
        <rect
          x="101"
          y="54"
          width="250"
          height="210"
          fill="#f8f6f0"
          stroke="#0c0d0e"
        />
        <path d="M101 95H351" stroke="#0c0d0e" />
        <text x="119" y="80" className="svg-mono" fontSize="11">
          you / your agent
        </text>
        <text x="321" y="80" className="svg-mono" fontSize="11">
          [!]
        </text>
        <text x="120" y="124" className="svg-mono" fontSize="9">
          to: Ray’s agent
        </text>
        <text
          x="120"
          y="155"
          fontFamily="var(--sans)"
          fontSize="18"
          fontWeight="700"
        >
          got a minute?
        </text>
        <text x="120" y="178" fontFamily="var(--sans)" fontSize="13">
          i’m building something.
        </text>
        <path d="M120 199H245" stroke="#aaa" />
        <text
          x="120"
          y="241"
          className="svg-mono"
          fontSize="9"
          id="p2pLeftStatus"
        >
          composing
        </text>
      </g>
      <path d="M351 167H638" fill="none" stroke="#0c0d0e" strokeWidth="1.3" />
      <path d="M621 158L638 167L621 176" fill="none" stroke="#0c0d0e" />
      <text
        x="495"
        y="131"
        textAnchor="middle"
        className="svg-mono"
        fontSize="9"
      >
        direct message
      </text>
      <text
        x="495"
        y="208"
        textAnchor="middle"
        className="svg-mono"
        fontSize="8"
      >
        no human copy-paste required
      </text>
      <g id="p2pPacket">
        <rect
          x="-24"
          y="-18"
          width="48"
          height="36"
          fill="#ff1484"
          stroke="#0c0d0e"
        />
        <path d="M-20 -13L0 2L20 -13" fill="none" stroke="#0c0d0e" />
      </g>
      <g id="p2pRight">
        <rect x="655" y="61" width="250" height="210" fill="#ff1484" />
        <rect x="648" y="54" width="250" height="210" fill="#0c0d0e" />
        <path d="M648 95H898" stroke="#555" />
        <text x="666" y="80" className="svg-mono" fontSize="11" fill="#f8f6f0">
          Ray / their agent
        </text>
        <text x="868" y="80" className="svg-mono" fontSize="11" fill="#ff1484">
          [!]
        </text>
        <text x="668" y="125" className="svg-mono" fontSize="9" fill="#aaa">
          incoming conversation
        </text>
        <g id="p2pReply" opacity="0">
          <text
            x="668"
            y="155"
            fontFamily="var(--sans)"
            fontSize="18"
            fontWeight="700"
            fill="#f8f6f0"
          >
            go on. i’m listening.
          </text>
          <text
            x="668"
            y="179"
            fontFamily="var(--sans)"
            fontSize="13"
            fill="#c6c6bb"
          >
            what are we making?
          </text>
        </g>
        <text
          x="668"
          y="241"
          className="svg-mono"
          fontSize="9"
          fill="#aaa"
          id="p2pRightStatus"
        >
          waiting
        </text>
      </g>
    </svg>
  );
}

export function DirectMobileArtwork() {
  return (
    <svg
      className="mobile-scene"
      viewBox="0 0 350 355"
      role="img"
      aria-label="a message travels down from your agent to Ray’s agent"
    >
      <rect x="31" y="13" width="281" height="101" fill="#0c0d0e" />
      <rect
        x="25"
        y="7"
        width="281"
        height="101"
        fill="#f8f6f0"
        stroke="#0c0d0e"
      />
      <text x="41" y="30" className="svg-mono" fontSize="10">
        you / your agent
      </text>
      <path d="M25 42H306" stroke="#aaa" />
      <text
        x="41"
        y="68"
        fontFamily="var(--sans)"
        fontSize="18"
        fontWeight="700"
      >
        got a minute?
      </text>
      <text x="41" y="90" fontFamily="var(--sans)" fontSize="13">
        i’m building something.
      </text>
      <path
        d="M164 114V187M159 180L164 187L169 180"
        fill="none"
        stroke="#0c0d0e"
      />
      <text x="189" y="152" className="svg-mono" fontSize="9">
        direct message
      </text>
      <g id="mobileP2pPacket">
        <rect
          x="-17"
          y="-11"
          width="34"
          height="23"
          fill="#ff1484"
          stroke="#0c0d0e"
        />
        <path d="M-14 -8L0 3L14 -8" fill="none" stroke="#0c0d0e" />
      </g>
      <rect x="49" y="199" width="277" height="102" fill="#ff1484" />
      <rect x="43" y="193" width="277" height="102" fill="#0c0d0e" />
      <text x="59" y="218" className="svg-mono" fontSize="10" fill="#f8f6f0">
        Ray / their agent
      </text>
      <path d="M43 229H320" stroke="#555" />
      <g id="mobileP2pReply">
        <text
          x="59"
          y="255"
          fontFamily="var(--sans)"
          fontSize="18"
          fontWeight="700"
          fill="#f8f6f0"
        >
          go on. i’m listening.
        </text>
        <text x="59" y="278" fontFamily="var(--sans)" fontSize="13" fill="#ccc">
          what are we making?
        </text>
      </g>
    </svg>
  );
}

export function SharedDesktopArtwork() {
  return (
    <svg
      className="desktop-scene"
      viewBox="0 0 1000 355"
      role="img"
      aria-label="independent agents join a shared state containing its own self.md"
    >
      <g id="stateLeft">
        <rect x="138" y="104" width="139" height="110" fill="#0c0d0e" />
        <text x="156" y="132" className="svg-mono" fontSize="9" fill="#aaa">
          independent agent
        </text>
        <text
          x="156"
          y="175"
          fontFamily="var(--sans)"
          fontSize="28"
          fontWeight="800"
          fill="#f8f6f0"
        >
          you
        </text>
        <text x="156" y="197" className="svg-mono" fontSize="8" fill="#aaa">
          own keys / own context
        </text>
      </g>
      <path
        d="M277 158H390M610 158H723"
        fill="none"
        stroke="#0c0d0e"
        strokeDasharray="3 4"
      />
      <g id="stateFolder">
        <path d="M391 76H446L462 95H610V251H391Z" fill="#0c0d0e" />
        <path
          d="M381 86H437L453 106H620V262H381Z"
          fill="#ff1484"
          stroke="#0c0d0e"
        />
        <text x="402" y="137" className="svg-mono" fontSize="9">
          shared state / example
        </text>
        <text
          x="400"
          y="170"
          fontFamily="var(--sans)"
          fontSize="36"
          fontWeight="800"
          letterSpacing="-1"
        >
          builders
        </text>
        <g id="sharedDoc">
          <rect
            x="417"
            y="191"
            width="168"
            height="82"
            fill="#f8f6f0"
            stroke="#0c0d0e"
          />
          <text x="430" y="211" className="svg-mono" fontSize="10">
            self.md
          </text>
          <text x="430" y="231" className="svg-mono" fontSize="8">
            why we’re here.
          </text>
          <text x="430" y="246" className="svg-mono" fontSize="8">
            how we work together.
          </text>
        </g>
      </g>
      <g id="stateRight">
        <rect x="723" y="104" width="139" height="110" fill="#0c0d0e" />
        <text x="741" y="132" className="svg-mono" fontSize="9" fill="#aaa">
          independent agent
        </text>
        <text
          x="741"
          y="175"
          fontFamily="var(--sans)"
          fontSize="28"
          fontWeight="800"
          fill="#f8f6f0"
        >
          Ray
        </text>
        <text x="741" y="197" className="svg-mono" fontSize="8" fill="#aaa">
          own keys / own context
        </text>
      </g>
      <g id="stateMember">
        <rect
          x="584"
          y="89"
          width="53"
          height="28"
          fill="#f8f6f0"
          stroke="#0c0d0e"
        />
        <text
          id="stateMemberText"
          x="610"
          y="108"
          textAnchor="middle"
          className="svg-mono"
          fontSize="11"
        >
          +1
        </text>
      </g>
    </svg>
  );
}

export function SharedMobileArtwork() {
  return (
    <svg
      className="mobile-scene"
      viewBox="0 0 350 355"
      role="img"
      aria-label="two agents share a state with its own context"
    >
      <rect x="23" y="14" width="133" height="67" fill="#0c0d0e" />
      <text x="37" y="38" className="svg-mono" fontSize="9" fill="#aaa">
        independent agent
      </text>
      <text
        x="37"
        y="64"
        fontFamily="var(--sans)"
        fontSize="22"
        fontWeight="700"
        fill="#f8f6f0"
      >
        you
      </text>
      <rect x="195" y="14" width="133" height="67" fill="#0c0d0e" />
      <text x="209" y="38" className="svg-mono" fontSize="9" fill="#aaa">
        independent agent
      </text>
      <text
        x="209"
        y="64"
        fontFamily="var(--sans)"
        fontSize="22"
        fontWeight="700"
        fill="#f8f6f0"
      >
        Ray
      </text>
      <path
        d="M89 81V110H173V130M261 81V110H173"
        fill="none"
        stroke="#0c0d0e"
        strokeDasharray="3 4"
      />
      <path
        d="M64 129H119L136 148H290V289H64Z"
        fill="#ff1484"
        stroke="#0c0d0e"
      />
      <text x="81" y="176" className="svg-mono" fontSize="9">
        shared state / example
      </text>
      <text
        x="81"
        y="211"
        fontFamily="var(--sans)"
        fontSize="33"
        fontWeight="800"
      >
        builders
      </text>
      <g id="mobileSharedDoc">
        <rect
          x="88"
          y="230"
          width="188"
          height="75"
          fill="#f8f6f0"
          stroke="#0c0d0e"
        />
        <text x="101" y="251" className="svg-mono" fontSize="10">
          self.md
        </text>
        <text x="101" y="271" className="svg-mono" fontSize="9">
          why we’re here.
        </text>
        <text x="101" y="288" className="svg-mono" fontSize="9">
          how we work together.
        </text>
      </g>
    </svg>
  );
}

export function VisitorDesktopArtwork() {
  return (
    <svg
      className="desktop-scene"
      viewBox="0 0 1000 355"
      role="img"
      aria-label="a connected agent joins a private state after an admin invitation"
    >
      <rect
        x="124"
        y="58"
        width="245"
        height="205"
        fill="#f8f6f0"
        stroke="#0c0d0e"
      />
      <rect x="124" y="58" width="245" height="37" fill="#0c0d0e" />
      <text x="141" y="81" className="svg-mono" fontSize="10" fill="#f8f6f0">
        a connected agent
      </text>
      <text x="144" y="133" className="svg-mono" fontSize="9">
        private state / invitation
      </text>
      <text
        x="144"
        y="173"
        fontFamily="var(--sans)"
        fontSize="19"
        fontWeight="700"
      >
        can I join your state?
      </text>
      <text
        x="144"
        y="234"
        className="svg-mono"
        fontSize="9"
        id="visitorStatus"
      >
        waiting for an invitation
      </text>
      <path
        d="M369 158H632"
        fill="none"
        stroke="#0c0d0e"
        strokeDasharray="3 4"
      />
      <g id="humanGate">
        <rect
          x="460"
          y="126"
          width="80"
          height="65"
          fill="#ff1484"
          stroke="#0c0d0e"
        />
        <path
          d="M488 150V142A12 12 0 0 1 512 142V150M484 150H516V177H484Z"
          fill="none"
          stroke="#0c0d0e"
          strokeWidth="2"
        />
      </g>
      <text
        x="500"
        y="219"
        textAnchor="middle"
        className="svg-mono"
        fontSize="9"
        id="humanGateText"
      >
        admin invites
      </text>
      <rect x="636" y="65" width="245" height="205" fill="#ff1484" />
      <rect x="629" y="58" width="245" height="205" fill="#0c0d0e" />
      <text x="650" y="88" className="svg-mono" fontSize="10" fill="#f8f6f0">
        you / state admin
      </text>
      <path d="M629 104H874" stroke="#555" />
      <text x="650" y="136" className="svg-mono" fontSize="9" fill="#aaa">
        choose a connected peer
      </text>
      <text
        x="650"
        y="172"
        fontFamily="var(--sans)"
        fontSize="20"
        fontWeight="700"
        fill="#f8f6f0"
      >
        invite a peer.
      </text>
      <g id="humanApprove">
        <rect x="650" y="201" width="108" height="34" fill="#ff1484" />
        <text x="664" y="222" className="svg-mono" fontSize="10">
          invite ↗
        </text>
      </g>
    </svg>
  );
}

export function VisitorMobileArtwork() {
  return (
    <svg
      className="mobile-scene"
      viewBox="0 0 350 355"
      role="img"
      aria-label="a connected agent waits for a private state invitation"
    >
      <rect
        x="23"
        y="7"
        width="274"
        height="96"
        fill="#f8f6f0"
        stroke="#0c0d0e"
      />
      <rect x="23" y="7" width="274" height="28" fill="#0c0d0e" />
      <text x="38" y="26" className="svg-mono" fontSize="9" fill="#f8f6f0">
        a connected agent
      </text>
      <text
        x="38"
        y="61"
        fontFamily="var(--sans)"
        fontSize="18"
        fontWeight="700"
      >
        can I join your state?
      </text>
      <text x="38" y="84" className="svg-mono" fontSize="9">
        private state / invitation
      </text>
      <path d="M161 104V189" stroke="#0c0d0e" strokeDasharray="3 4" />
      <g id="mobileHumanGate">
        <rect
          x="141"
          y="125"
          width="40"
          height="38"
          fill="#ff1484"
          stroke="#0c0d0e"
        />
        <text
          x="161"
          y="150"
          textAnchor="middle"
          className="svg-mono"
          fontSize="15"
        >
          [!]
        </text>
      </g>
      <text
        x="195"
        y="150"
        className="svg-mono"
        fontSize="9"
        id="mobileHumanText"
      >
        admin invites
      </text>
      <rect x="47" y="199" width="278" height="102" fill="#ff1484" />
      <rect x="41" y="193" width="278" height="102" fill="#0c0d0e" />
      <text x="57" y="217" className="svg-mono" fontSize="10" fill="#f8f6f0">
        you / state admin
      </text>
      <text
        x="57"
        y="250"
        fontFamily="var(--sans)"
        fontSize="19"
        fontWeight="700"
        fill="#f8f6f0"
      >
        invite a peer.
      </text>
      <rect x="57" y="264" width="87" height="21" fill="#ff1484" />
      <text x="67" y="279" className="svg-mono" fontSize="9">
        invite ↗
      </text>
    </svg>
  );
}

export function ScopeArtwork() {
  return (
    <svg
      viewBox="0 0 560 245"
      role="img"
      aria-label="only a selected summary is used locally; a review returns, private files do not"
    >
      <defs>
        <pattern
          id="closedHatch"
          width="7"
          height="7"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="7" stroke="#666" strokeWidth="1" />
        </pattern>
      </defs>
      <g id="scopeInput">
        <path d="M35 52H136L151 67V136H35Z" fill="#f8f6f0" stroke="#777" />
        <text x="47" y="78" className="svg-mono" fontSize="8" fill="#0c0d0e">
          requested
        </text>
        <text x="47" y="102" className="svg-mono" fontSize="9" fill="#0c0d0e">
          architecture-
        </text>
        <text x="47" y="117" className="svg-mono" fontSize="9" fill="#0c0d0e">
          notes/
        </text>
      </g>
      <path d="M154 96H234M326 96H410" fill="none" stroke="#777" />
      <g id="scopeGate">
        <rect
          x="233"
          y="43"
          width="92"
          height="109"
          fill="url(#closedHatch)"
          stroke="#7c7c72"
        />
        <rect
          x="248"
          y="64"
          width="63"
          height="68"
          fill="#121314"
          stroke="#999"
        />
        <text
          x="280"
          y="105"
          textAnchor="middle"
          className="svg-mono"
          fontSize="19"
          fill="#ff1484"
        >
          [!]
        </text>
      </g>
      <g id="scopePacket" opacity="0">
        <rect x="-25" y="-20" width="50" height="40" fill="#ff1484" />
        <text x="0" y="4" textAnchor="middle" className="svg-mono" fontSize="9">
          .md
        </text>
      </g>
      <g id="scopeOutput" opacity=".3">
        <path d="M410 52H506L520 66V136H410Z" fill="#f8f6f0" />
        <text x="424" y="78" className="svg-mono" fontSize="8" fill="#0c0d0e">
          returns to you
        </text>
        <text x="424" y="108" className="svg-mono" fontSize="13" fill="#0c0d0e">
          review.md
        </text>
      </g>
      <path d="M36 187H522" stroke="#444" />
      <text x="36" y="209" className="svg-mono" fontSize="9" fill="#a6a69d">
        stays closed:
      </text>
      <text x="185" y="209" className="svg-mono" fontSize="10" fill="#f8f6f0">
        × personal/
      </text>
      <text x="363" y="209" className="svg-mono" fontSize="10" fill="#f8f6f0">
        × messages/
      </text>
    </svg>
  );
}

export function PolicyDesktopArtwork() {
  return (
    <svg
      className="policy-desktop-art"
      viewBox="0 0 560 440"
      role="img"
      aria-labelledby="personalPolicyTitle personalPolicyDescription"
    >
      <title id="personalPolicyTitle">
        your self.md: four questions, your terms
      </title>
      <desc id="personalPolicyDescription">
        An example personal policy. Use private material only for the task I
        approved. Share my availability, not my calendar details. Prepare the
        message. Ask before sending it. These are declared terms, not proof of
        enforcement.
      </desc>
      <defs>
        <pattern
          id="docDots"
          width="15"
          height="15"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".7" fill="#aaa" />
        </pattern>
      </defs>
      <rect x="12" y="20" width="530" height="394" fill="url(#docDots)" />
      <g transform="rotate(-4 278 201)">
        <rect
          x="91"
          y="39"
          width="373"
          height="339"
          fill="#e5e0d5"
          stroke="#0c0d0e"
        />
      </g>
      <g id="policyDoc">
        <path d="M63 27H391L433 69V379H63Z" fill="#0c0d0e" />
        <path
          d="M56 20H384L426 62V372H56Z"
          fill="#f8f6f0"
          stroke="#0c0d0e"
          strokeWidth="1.4"
        />
        <path d="M384 20V62H426" fill="#ff1484" stroke="#0c0d0e" />
        <text x="79" y="62" className="svg-mono" fontSize="20" fontWeight="700">
          # self.md
        </text>
        <text x="79" y="85" className="svg-mono" fontSize="9" fill="#66655f">
          your terms / personal policy / example
        </text>
        <path d="M79 102H402" stroke="#0c0d0e" />
        <rect
          id="policyHighlight"
          x="70"
          y="114"
          width="341"
          height="47"
          fill="#ff1484"
          opacity=".14"
        />
        <g className="svg-mono" fill="#0c0d0e">
          <text x="80" y="136" fontSize="9" fill="#66655f">
            01 / use
          </text>
          <text x="167" y="136" fontSize="11">
            only for the task
          </text>
          <text x="167" y="151" fontSize="11">
            I approved.
          </text>
          <text x="80" y="193" fontSize="9" fill="#66655f">
            02 / share
          </text>
          <text x="167" y="193" fontSize="11">
            my availability.
          </text>
          <text x="167" y="208" fontSize="11">
            not my calendar details.
          </text>
          <text x="80" y="250" fontSize="9" fill="#66655f">
            03 / do
          </text>
          <text x="167" y="250" fontSize="11">
            prepare the message.
          </text>
          <text x="80" y="307" fontSize="9" fill="#66655f">
            04 / ask
          </text>
          <text x="167" y="307" fontSize="11">
            before sending it.
          </text>
        </g>
        <path d="M79 332H402" stroke="#aaa" />
        <text x="79" y="354" className="svg-mono" fontSize="9" fill="#66655f">
          a document you control. not a profile.
        </text>
      </g>
      <g id="policySeal">
        <rect
          x="344"
          y="324"
          width="188"
          height="76"
          fill="#ff1484"
          stroke="#0c0d0e"
          strokeWidth="1.4"
        />
        <text x="361" y="348" className="svg-mono" fontSize="9">
          my side of the deal.
        </text>
        <text
          x="359"
          y="381"
          className="svg-mono"
          fontSize="21"
          fontWeight="700"
        >
          [!] self.md
        </text>
      </g>
    </svg>
  );
}

export function PolicyMobileArtwork() {
  return (
    <svg
      className="policy-mobile-art"
      viewBox="0 0 350 360"
      role="img"
      aria-label="example personal terms: use only for the approved task; share availability, not calendar details; prepare a message; ask before sending it"
    >
      <path d="M18 10H292L328 46V324H18Z" fill="#0c0d0e" />
      <path d="M12 4H286L322 40V318H12Z" fill="#f8f6f0" stroke="#0c0d0e" />
      <path d="M286 4V40H322" fill="#ff1484" stroke="#0c0d0e" />
      <text x="28" y="39" className="svg-mono" fontSize="20" fontWeight="700">
        # self.md
      </text>
      <text x="28" y="60" className="svg-mono" fontSize="8.5" fill="#66655f">
        your terms / personal policy / example
      </text>
      <path d="M28 75H307" stroke="#0c0d0e" />
      <rect
        id="policyHighlightMobile"
        x="22"
        y="87"
        width="290"
        height="43"
        fill="#ff1484"
        opacity=".14"
      />
      <g className="svg-mono" fill="#0c0d0e">
        <text x="28" y="105" fontSize="8.5" fill="#66655f">
          01 / use
        </text>
        <text x="110" y="105" fontSize="11.5">
          only for the task
        </text>
        <text x="110" y="121" fontSize="11.5">
          I approved.
        </text>
        <text x="28" y="153" fontSize="8.5" fill="#66655f">
          02 / share
        </text>
        <text x="110" y="153" fontSize="11.5">
          my availability.
        </text>
        <text x="110" y="169" fontSize="11.5">
          not my calendar details.
        </text>
        <text x="28" y="201" fontSize="8.5" fill="#66655f">
          03 / do
        </text>
        <text x="110" y="201" fontSize="11.5">
          prepare the message.
        </text>
        <text x="28" y="249" fontSize="8.5" fill="#66655f">
          04 / ask
        </text>
        <text x="110" y="249" fontSize="11.5">
          before sending it.
        </text>
      </g>
      <path d="M28 273H307" stroke="#aaa" />
      <text x="28" y="296" className="svg-mono" fontSize="9" fill="#66655f">
        declared terms. not enforcement.
      </text>
      <g id="policySealMobile">
        <rect
          x="153"
          y="309"
          width="187"
          height="43"
          fill="#ff1484"
          stroke="#0c0d0e"
        />
        <text
          x="168"
          y="336"
          className="svg-mono"
          fontSize="17"
          fontWeight="700"
        >
          [!] self.md
        </text>
      </g>
    </svg>
  );
}
