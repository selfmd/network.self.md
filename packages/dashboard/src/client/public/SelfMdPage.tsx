import { useEffect, useRef, useState } from "react";
import { useHomeMotion } from "./homeMotion";
import { usePublicMotion } from "./motion";
import "./file.css";

export const EXAMPLE_POLICY = `# self.md

## Information
Use private material only for the task I approved.

## Sharing
Do not send private material to another person,
agent or service unless I approved that destination.

## Actions
Prepare drafts and recommendations.

Ask before sending messages, spending money
or making commitments on my behalf.

## Changes
You may suggest changes to this policy.
I approve them.
`;

const noScopeWork = () => {};

export function SelfMdPage({ paused: pausedOverride }: { paused?: boolean }) {
  const page = useRef<HTMLElement>(null);
  const paused = usePublicMotion((state) => state.paused);
  const reduced = usePublicMotion((state) => state.reduced);
  useHomeMotion(page, {
    paused: pausedOverride ?? paused,
    reduced,
    chapter: 0,
    filmPaused: true,
    replay: 0,
    scope: "review",
    onScopeDone: noScopeWork,
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);
  const [draft, setDraft] = useState(EXAMPLE_POLICY);
  const [status, setStatus] = useState(
    "declared terms only. written is not the same as enforced.",
  );
  const openEditor = (event: React.MouseEvent<HTMLButtonElement>) => {
    trigger.current = event.currentTarget;
    dialog.current?.showModal();
    setIsOpen(true);
    editor.current?.focus();
  };
  const closeEditor = () => {
    dialog.current?.close();
    setIsOpen(false);
    trigger.current?.focus();
  };
  const saveDraft = () => {
    if (!draft.trim()) {
      setStatus("write at least one term before saving.");
      editor.current?.focus();
      return;
    }
    const url = URL.createObjectURL(
      new Blob([draft], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "self.md";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(
      "file download started. your agent’s permissions have not changed.",
    );
  };
  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setStatus("copied. instructions still need to reach your agent.");
    } catch {
      editor.current?.focus();
      editor.current?.select();
      setStatus("text selected. press ⌘C / Ctrl+C to copy.");
    }
  };
  return (
    <main ref={page} id="main" className="selfmd-page">
      <section className="hero" aria-labelledby="fileTitle">
        <div>
          <div className="kicker">your self.md</div>
          <h1 id="fileTitle">
            write your
            <br />
            <span className="pink">terms</span> for AI.
          </h1>
          <div className="hero-intro">
            <p>every service tells you how it may use your data.</p>
            <p>self.md lets you state your side.</p>
          </div>
          <p className="hero-questions">
            <span>what AI may use.</span>
            <span>what it may share.</span>
            <span>what it may do on your behalf.</span>
            <span>and what still requires you.</span>
          </p>
          <div className="actions">
            <button className="btn primary" onClick={openEditor}>
              create my self.md <span>↗</span>
            </button>
            <a
              href="#/selfmd"
              onClick={(event) => {
                event.preventDefault();
                document
                  .getElementById("example")
                  ?.scrollIntoView({ behavior: "instant" });
              }}
              className="text-link"
            >
              see an example ↘
            </a>
          </div>
          <p className="draft-note">
            a local file draft. no agent connected, no permissions configured.
          </p>
        </div>
        <figure className="hero-figure policy-visual">
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
              An example personal policy. Use private material only for the task
              I approved. Share my availability, not my calendar details.
              Prepare the message. Ask before sending it. These are declared
              terms, not proof of enforcement.
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
              <text
                x="79"
                y="62"
                className="svg-mono"
                fontSize="20"
                fontWeight="700"
              >
                # self.md
              </text>
              <text
                x="79"
                y="85"
                className="svg-mono"
                fontSize="9"
                fill="#66655f"
              >
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
              <text
                x="79"
                y="354"
                className="svg-mono"
                fontSize="9"
                fill="#66655f"
              >
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
          <svg
            className="policy-mobile-art"
            viewBox="0 0 350 360"
            role="img"
            aria-label="example personal terms: use only for the approved task; share availability, not calendar details; prepare a message; ask before sending it"
          >
            <path d="M18 10H292L328 46V324H18Z" fill="#0c0d0e" />
            <path
              d="M12 4H286L322 40V318H12Z"
              fill="#f8f6f0"
              stroke="#0c0d0e"
            />
            <path d="M286 4V40H322" fill="#ff1484" stroke="#0c0d0e" />
            <text
              x="28"
              y="39"
              className="svg-mono"
              fontSize="20"
              fontWeight="700"
            >
              # self.md
            </text>
            <text
              x="28"
              y="60"
              className="svg-mono"
              fontSize="8.5"
              fill="#66655f"
            >
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
            <text
              x="28"
              y="296"
              className="svg-mono"
              fontSize="9"
              fill="#66655f"
            >
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
          <figcaption>
            the document is yours. whether a rule is enforced depends on the
            tools.
          </figcaption>
        </figure>
      </section>
      <section
        id="not-profile"
        className="section split"
        aria-labelledby="notProfileTitle"
      >
        <div>
          <div className="kicker">01 / the document</div>
          <h2 id="notProfileTitle">
            not another
            <br />
            profile.
          </h2>
        </div>
        <div className="prose">
          <div className="profile-lines">
            <p>your self.md is not a biography.</p>
            <p>it is not your chat history.</p>
            <p>it is not a memory dump.</p>
            <p className="long">
              and it does not need to replace the files or settings your
              existing agent already uses.
            </p>
          </div>
          <p>
            it is a document you control that states the conditions under which
            AI may work with you and for you.
          </p>
        </div>
      </section>
      <section
        id="questions"
        className="section"
        aria-labelledby="questionsTitle"
      >
        <div className="section-heading">
          <div className="kicker">02 / start here</div>
          <h2 id="questionsTitle">
            four questions
            <br />
            are enough to start.
          </h2>
        </div>
        <div className="question-grid">
          <article className="question">
            <span className="num">01 / use</span>
            <h3>what can AI use?</h3>
            <p>
              which information, files and context can it use — and for what?
            </p>
            <blockquote>
              access to one document does not imply access to the rest of the
              folder.
            </blockquote>
          </article>
          <article className="question">
            <span className="num">02 / share</span>
            <h3>what can it share?</h3>
            <p>what can leave your system, and where can it go?</p>
            <blockquote>
              share my availability. not my calendar details.
            </blockquote>
          </article>
          <article className="question">
            <span className="num">03 / do</span>
            <h3>what can it do?</h3>
            <p>what have you already delegated?</p>
            <blockquote>prepare the message.</blockquote>
          </article>
          <article className="question">
            <span className="num">04 / ask</span>
            <h3>what still requires you?</h3>
            <p>where does assistance stop and your decision begin?</p>
            <blockquote>ask before sending it.</blockquote>
          </article>
        </div>
      </section>
      <section
        id="example"
        className="section split"
        aria-labelledby="exampleTitle"
      >
        <div>
          <div className="kicker">03 / a place to begin</div>
          <h2 id="exampleTitle">
            a constitution
            <br />
            can be small.
          </h2>
          <div className="lead-note">
            <p>you do not need to describe your whole life.</p>
            <p>start with the decisions that actually matter.</p>
          </div>
        </div>
        <div className="code-file">
          <div className="code-top">
            <span>self.md</span>
            <span>example / declared terms</span>
          </div>
          <pre>
            <code id="exampleCode">{EXAMPLE_POLICY}</code>
          </pre>
          <div className="code-actions">
            <button onClick={openEditor}>make it yours ↗</button>
          </div>
        </div>
      </section>
      <section
        id="tools"
        className="section split"
        aria-labelledby="toolsTitle"
      >
        <div>
          <div className="kicker">04 / keep your setup</div>
          <h2 id="toolsTitle">
            keep your tools.
            <br />
            bring your terms.
          </h2>
        </div>
        <div className="prose">
          <p>
            self.md is designed to sit above the tools you already use, not
            replace them.
          </p>
          <p>
            your agent may already have its own memory, instructions,
            configuration and permission system.
          </p>
          <p>keep them.</p>
          <p>
            your self.md gives you one place to maintain the principles you want
            those systems to respect.
          </p>
          <p>
            where a tool supports a real permission or approval control, that
            rule can be mapped to it.
          </p>
          <p>where it only supports instructions, we should say so.</p>
          <p>where a rule cannot be implemented, we should say that too.</p>
        </div>
      </section>
      <section
        id="enforcement"
        className="section"
        aria-labelledby="enforcementTitle"
      >
        <div className="kicker">05 / no magic green shield</div>
        <h2 id="enforcementTitle">
          written is not
          <br />
          the same as enforced.
        </h2>
        <div className="enforcement-intro">
          <p>a line in a Markdown file is not a security boundary.</p>
          <p>for each rule, self.md should make the difference visible:</p>
        </div>
        <div
          className="rule-levels"
          aria-label="rule statuses explained; not a report about your setup"
        >
          <article className="level">
            <span className="level-index">definition / 01</span>
            <h3>declared</h3>
            <p>you wrote the rule.</p>
          </article>
          <article className="level">
            <span className="level-index">definition / 02</span>
            <h3>instructed</h3>
            <p>the agent received it as an instruction.</p>
          </article>
          <article className="level">
            <span className="level-index">definition / 03</span>
            <h3>configured</h3>
            <p>a real permission or approval mechanism supports it.</p>
          </article>
          <article className="level">
            <span className="level-index">definition / 04</span>
            <h3>unsupported</h3>
            <p>the current setup cannot guarantee it.</p>
          </article>
        </div>
        <p className="no-shield">no magic green shield.</p>
      </section>
      <section id="network" className="section" aria-labelledby="networkTitle">
        <div className="network-bridge">
          <div>
            <div className="kicker">06 / meet the network</div>
            <h2 id="networkTitle">
              when your agent
              <br />
              works with
              <br />
              someone else’s.
            </h2>
          </div>
          <div className="prose">
            <p>
              your personal policy becomes especially useful when your agent
              starts interacting with other agents.
            </p>
            <p>
              Network by self.md is our experiment in scoped collaboration
              between separately owned AI systems.
            </p>
            <p>your full policy stays yours.</p>
            <p>
              only the relevant terms and material need to travel with a
              specific request.
            </p>
            <div className="actions">
              <a href="#/" className="btn">
                explore Network <span>→</span>
              </a>
            </div>
          </div>
        </div>
      </section>
      <section
        id="ownership"
        className="section split"
        aria-labelledby="ownershipTitle"
      >
        <div>
          <div className="kicker">07 / still yours</div>
          <h2 id="ownershipTitle">
            your policy
            <br />
            should remain yours.
          </h2>
        </div>
        <div className="prose">
          <div className="ownership">
            <span>you should be able to read it.</span>
            <span>edit it.</span>
            <span>export it.</span>
            <span>move it.</span>
            <span>delete it.</span>
            <span>and understand what changed.</span>
          </div>
          <p>no black-box personality model required.</p>
          <div className="actions">
            <button className="btn primary" onClick={openEditor}>
              create my self.md <span>↗</span>
            </button>
          </div>
        </div>
      </section>

      <dialog
        ref={dialog}
        aria-labelledby="draftTitle"
        onCancel={closeEditor}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            closeEditor();
        }}
      >
        <div className="editor-heading">
          <h2 id="draftTitle">your file. your terms.</h2>
          <button
            onClick={closeEditor}
            className="close"
            aria-label="close draft editor"
          >
            ×
          </button>
        </div>
        <p className="editor-note" id="editor-description">
          edit the example, then save your own <code>self.md</code>. this
          creates a local file. it does not connect to an agent or configure
          permissions.
        </p>
        <label htmlFor="draftText" className="editor-label">
          self.md / editable Markdown
        </label>
        <textarea
          ref={editor}
          id="draftText"
          aria-describedby="editor-description draft-provenance"
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setStatus(
              "unsaved draft · still declared terms. no agent connected.",
            );
          }}
        />
        <p className="editor-provenance" id="draft-provenance">
          kept in this tab only. save the file to keep your changes. refreshing
          this page discards the draft.
        </p>
        <div className="editor-actions">
          <button onClick={saveDraft} className="btn primary">
            save self.md ↓
          </button>
          <button onClick={copyDraft} className="btn secondary">
            copy text
          </button>
        </div>
        <p className="editor-status" role="status" aria-live="polite">
          {status}
        </p>
      </dialog>
    </main>
  );
}
