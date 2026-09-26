/**
 * Pre-routing context resolution.
 * Resolve short follow-ups / pronouns / confirmations against recent turns
 * BEFORE mode, task, research, or verification classifiers run.
 *
 * Priority lanes (Self Repair / persona) are resolved first via turn-priority.mjs
 * and must never be swallowed by fast-path or stale follow-up expansion.
 */

import {
  classifyPriorityLane,
  priorityTurnOverrides,
} from "./turn-priority.mjs";
import { classifyPcDiagnosticIntent } from "./pc-diagnostics.mjs";
import {
  canReuseSecurityFileTarget,
  classifySecurityIntent,
  withSecurityTarget,
} from "./security/index.mjs";
import {
  extractSecurityFileTarget,
  isSecurityTargetFollowUp,
  securityBinaryExtension,
} from "./security/target.mjs";
import {
  applyStylePatch,
  classifyArabicFollowUp,
  classifyStyleCommand,
  formatConversationStylePrompt,
  formatFinalOutputContract,
  normalizeConversationStyle,
} from "./conversation-style.mjs";
import {
  extractCanonicalTopic,
  formatSemanticUnderstandingPrompt,
  normalizeJeddawiSemantics,
} from "./jeddawi-semantics.mjs";
import {
  applySpeakerPersonaClaim,
  formatSpeakerPersonaPrompt,
} from "./speaker-persona.mjs";
import { isPureGreeting } from "./greeting.mjs";

const CONFIRM =
  /^(?:y(?:eah|ep|ea|up|a)?|yes|sure|ok(?:ay)?|alright|right|correct|affirmative|do it|go ahead|proceed|please do|go for it|sounds good|that(?:'s| is) fine|نعم|ايوه|أيوه|أيوا|ايوا|يب|تمام|اوك|أوك|موافق|نفّذ|نفذ|سويه|سوّيه|يلا|امش|يمشي)[.!؟\s]*$/iu;

const REJECT =
  /^(?:n(?:o|ope|ah)?|cancel|never ?mind|don'?t|stop|غلط|لا|كانسل|الغي|ألغ(?:ي|ى)?)[.!؟\s]*$/iu;

const CONTINUE =
  /^(?:continue|go on|keep going|next|carry on|resume|كمل|كمّل|كملها|كمّلها|تابع|استمر)[.!؟\s]*$/iu;

const FIX_REF =
  /^(?:fix (?:it|that|this)|repair (?:it|that)|صلحه|أصلحه|اصلحه)[.!؟\s]*$/iu;

const REWRITE =
  /^(?:make (?:it|your answer|the answer|that|this) (?:shorter|simpler|better|clearer|brief|concise)|make (?:it|your answer) (?:a )?(?:bit |little )?shorter|simplify(?: it)?|rewrite(?: it)?|shorten(?: it| your answer)?|clean(?: it)? up|be (?:more )?concise|ابغاك.{0,40}(?:تعد(?:ّ|ل)?|بسط|أبسط).{0,40}|عد(?:ّ|ل)?ها.{0,20}|بسطها|بسّطها|خليها\s*أبسط|خلها\s*أبسط|اختصر(?:ها)?|بسّط)[.!؟\s]*$/iu;

/** Recent-turn recall (transient facts — not long-term memory). */
const RECALL_RECENT =
  /^(?:what (?:color |thing )?(?:did i|have i)(?: just)? (?:tell|say|mention)(?: you)?(?:\s+about)?.{0,40}|what (?:was|is) (?:the |my )?(?:color|favorite color)|what did i just say|remind me what i (?:just )?(?:said|told you)|وش قلت|إيش قلت|ماذا قلت|شو قلت|ما (?:هو )?اللون|إيش اللون|وش اللون)[.!؟\s]*$/iu;

const SELECT_SECOND =
  /^(?:the second(?: one)?(?: is better)?|option\s*2|b(?:\s+is better)?|(?:ال)?ثاني(?:ة)?(?:\s+أفضل)?|الثانية\s*أفضل)[.!؟\s]*$/iu;

const SELECT_FIRST =
  /^(?:the first(?: one)?(?: is better)?|option\s*1|a(?:\s+is better)?|(?:ال)?أول(?:ى)?(?:\s+أفضل)?|الأولى\s*أفضل)[.!؟\s]*$/iu;

const REFERENCE =
  /^(?:that one|this one|the (?:first|second|third) one|what about (?:this|that|it)|about (?:this|that)|هذا|هذي|ذاك|ذلك|الأول|الثاني)[.!؟\s]*$/iu;

const WHY_HOW =
  /^(?:why\??|how\??|what about that\??|اش رايك\??|إيش رأيك\??|ليش\??|كيف\??)[.!؟\s]*$/iu;

const GREETING =
  /^(?:hi|hello|hey(?:\s+jack)?|yo|thanks|thank you|thx|ty|good\s*morning|good\s*afternoon|good\s*evening|how are you(?: doing)?|what's up|sup|مرحبا|هلا|هاي|السلام عليكم|صباح الخير|مساء الخير|كيفك|كيف حالك|شكرا|شكراً)[.!؟\s]*$/iu;

const EXPLICIT_REMEMBER =
  /\b(?:remember (?:this|that|it)|save (?:this|that)|store (?:this|that)|don't forget|تذك[كر]|احفظ|خزّن|خزن)\b/i;

const EXPLICIT_VERIFY =
  /\b(verify|check (?:the |these )?sources?|research|cite|ابحث|تحقق|أكد|مصادر)\b/i;

/**
 * Structured snapshot of recent conversation for deterministic follow-ups.
 */
export function buildRecentContext(history = [], { canonicalTopic = null } = {}) {
  const messages = Array.isArray(history) ? history.slice(-24) : [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const assistantText = String(lastAssistant?.content || "");
  const userText = String(lastUser?.content || "");
  const recentTurns = messages.slice(-8).map((m) => ({
    role: m.role,
    content: String(m.content || "").slice(0, 400),
  }));
  const inferred =
    canonicalTopic ||
    extractCanonicalTopic(userText, extractCanonicalTopic(assistantText, null));
  return {
    lastAssistant: assistantText,
    lastUser: userText,
    lastExecutableProposal: extractExecutableProposal(assistantText),
    lastOptions: extractOptions(assistantText),
    lastTopic: inferred || summarizeTopic(assistantText || userText),
    canonicalTopic: inferred || null,
    transientFacts: extractTransientFacts(messages),
    recentTurns,
    messages,
  };
}

function extractExecutableProposal(text) {
  if (!text) return "";
  const offer =
    text.match(
      /(?:I can|Shall I|Want me to|Let me|I could|Would you like me to)\s+([^\n.!?]{8,220})/i,
    ) ||
    text.match(
      /(?:أقدر|أقدر أسوي|ممكن|خلني|دعني)\s+([^\n.!؟]{8,220})/i,
    ) ||
    text.match(
      /(?:Would you like|Want me to|Shall I)\s+([^\n.?!]{8,220})\?/i,
    );
  if (offer) return offer[0].trim().slice(0, 280);
  // Do NOT treat ordinary acknowledgements ("I will use purple") as proposals.
  return "";
}

/**
 * Transient conversation facts from recent user turns (chat-scoped, not long-term memory).
 */
export function extractTransientFacts(history = []) {
  const facts = [];
  const seen = new Set();
  const users = (Array.isArray(history) ? history : [])
    .filter((m) => m.role === "user")
    .slice(-8);
  for (const m of users) {
    const text = String(m.content || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const color =
      text.match(
        /(?:favorite|favourite)\s+color(?:\s+for this (?:conversation|chat|session))?\s+is\s+([A-Za-z\u0600-\u06ff]+)/i,
      ) ||
      text.match(
        /(?:my color for this (?:conversation|chat)\s+is|color(?:\s+for now)?\s+is)\s+([A-Za-z\u0600-\u06ff]+)/i,
      ) ||
      text.match(
        /(?:لوني المفضل|اللون المفضل)(?:\s+لهذه\s*(?:المحادثة|الجلسة))?\s*(?:هو|:)?\s*([A-Za-z\u0600-\u06ff]+)/i,
      );
    if (color) {
      const value = color[1].trim();
      const key = `favorite_color:${value.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        facts.push({
          key: "favorite_color",
          value,
          scope: "conversation",
          evidence: text.slice(0, 180),
        });
      }
      continue; // color line already captured — skip generic scoped note
    }
    const scoped = text.match(
      /\b(?:for this (?:conversation|chat|session)|in this (?:conversation|chat)|for now)\b[,:]?\s+(.{3,120})/i,
    );
    if (scoped) {
      const value = scoped[1].replace(/[.!?].*$/, "").trim().slice(0, 100);
      const key = `scoped:${value.toLowerCase()}`;
      if (value && !seen.has(key)) {
        seen.add(key);
        facts.push({
          key: "conversation_note",
          value,
          scope: "conversation",
          evidence: text.slice(0, 180),
        });
      }
    }
  }
  return facts.slice(-6);
}

/**
 * Detect language-switch requests (must preserve topic).
 * Prefer classifyStyleCommand for dialect-aware switches.
 * @returns {{ language: 'ar'|'en', continueTopic: boolean, arabic_style?: string } | null}
 */
export function classifyLanguageSwitch(text = "") {
  const styled = classifyStyleCommand(text);
  if (styled?.patch?.language === "en")
    return { language: "en", continueTopic: true };
  if (styled?.kind === "jeddawi")
    return {
      language: "ar",
      arabic_style: "jeddawi",
      continueTopic: true,
    };
  if (styled?.kind === "msa")
    return { language: "ar", arabic_style: "msa", continueTopic: true };
  if (styled?.kind === "arabic")
    return { language: "ar", continueTopic: true };

  const t = String(text || "").trim();
  if (!t || t.length > 120) return null;
  const toAr =
    /(?:تكلم|احكي|رد|اكتب|جاوب).{0,24}(?:عربي|بالعربي|العربية)/i.test(t) ||
    /(?:speak|talk|reply|answer|switch).{0,36}\barabic\b/i.test(t) ||
    /^(?:بالعربي|عربي)[.!؟\s]*$/i.test(t);
  const toEn =
    /(?:تكلم|احكي|رد|اكتب|جاوب|كمل|كمّل).{0,24}(?:انجليزي|بالانجليزي|الإنجليزية|الانجليزية)/i.test(
      t,
    ) ||
    /(?:speak|talk|reply|answer|switch|continue).{0,36}\benglish\b/i.test(t) ||
    /^(?:بالانجليزي|انجليزي|English(?:\s+please)?)[.!؟\s]*$/i.test(t);
  if (toAr && !toEn)
    return {
      language: "ar",
      continueTopic: /كمل|continue|keep going|تابع/i.test(t),
    };
  if (toEn && !toAr)
    return {
      language: "en",
      continueTopic: true,
    };
  return null;
}

/**
 * Compact active-thread block for fast path (and follow-ups). Bounded size.
 */
export function formatCompactThreadContext(snapshot = {}, { maxChars = 1800, style = null } = {}) {
  const lines = ["ACTIVE THREAD (recent conversation — use this; do not invent):"];
  if (style) {
    const s = normalizeConversationStyle(style);
    lines.push(
      `Style: language=${s.language} arabic_style=${s.arabic_style} tone=${s.tone} verbosity=${s.verbosity}`,
    );
  }
  if (snapshot.canonicalTopic) {
    lines.push(
      `Canonical topic (semantic, not slang, not prior wording): ${String(snapshot.canonicalTopic).slice(0, 200)}`,
    );
  }
  const facts = snapshot.transientFacts || [];
  if (facts.length) {
    lines.push("Transient facts (this chat only — not long-term memory):");
    for (const f of facts) {
      lines.push(`- ${f.key}: ${f.value}`);
    }
  }
  if (snapshot.lastUser)
    lines.push(`Last user: ${String(snapshot.lastUser).slice(0, 280)}`);
  if (snapshot.lastAssistant)
    lines.push(
      `Last assistant: ${String(snapshot.lastAssistant).slice(0, 400)}`,
    );
  if (snapshot.lastExecutableProposal)
    lines.push(
      `Open proposal: ${String(snapshot.lastExecutableProposal).slice(0, 220)}`,
    );
  else lines.push("Open proposal: (none)");
  if (snapshot.lastTopic && snapshot.lastTopic !== snapshot.canonicalTopic)
    lines.push(`Legacy topic hint: ${String(snapshot.lastTopic).slice(0, 120)}`);
  const recent = (snapshot.recentTurns || []).slice(-8);
  if (recent.length) {
    lines.push("Recent turns:");
    for (const turn of recent) {
      lines.push(
        `- ${turn.role}: ${String(turn.content || "").replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…";
  return text;
}

function extractOptions(text) {
  if (!text) return [];
  const options = [];
  const numbered = [
    ...text.matchAll(
      /(?:^|\n)\s*(?:(?:option\s*)?([1-3]|[أابب]|[abc]))[).:\-–]\s*([^\n]{3,160})/gi,
    ),
  ];
  for (const m of numbered) {
    options.push({ key: String(m[1]).toLowerCase(), text: m[2].trim() });
  }
  if (options.length >= 2) return options.slice(0, 4);
  // Fallback: split on " أو " / " or " style binary choices in one line.
  const binary = text.match(
    /(?:^|\n)\s*(.{8,120}?)\s+(?:or|أو)\s+(.{8,120}?)(?:[.!؟\n]|$)/i,
  );
  if (binary)
    return [
      { key: "1", text: binary[1].trim() },
      { key: "2", text: binary[2].trim() },
    ];
  return [];
}

function summarizeTopic(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * Classify dialogue act (before task/mode routing).
 */
export function classifyConversationIntent(text = "", { history = [] } = {}) {
  const trimmed = String(text || "").trim();
  const snapshot = buildRecentContext(history);
  if (!trimmed) {
    return {
      intent: "task",
      conversational: false,
      needsVerification: false,
      expandWithContext: false,
      snapshot,
    };
  }

  let intent = "task";
  const styleCommand = classifyStyleCommand(trimmed);
  const languageSwitch = classifyLanguageSwitch(trimmed);
  const arabicFollow = classifyArabicFollowUp(trimmed);
  const semantic = normalizeJeddawiSemantics(trimmed);

  if (CONFIRM.test(trimmed)) intent = "confirm";
  else if (REJECT.test(trimmed)) intent = "reject";
  else if (CONTINUE.test(trimmed)) intent = "continue";
  else if (semantic.kind === "gist" || semantic.kind === "be_direct")
    intent = "rewrite";
  else if (arabicFollow?.intent === "rewrite" || REWRITE.test(trimmed))
    intent = "rewrite";
  else if (arabicFollow?.intent === "continue") intent = "continue";
  else if (arabicFollow?.intent === "confirm") intent = "confirm";
  else if (arabicFollow?.intent === "clarify") intent = "clarify";
  else if (styleCommand) intent = "style_switch";
  else if (languageSwitch) intent = "language_switch";
  else if (arabicFollow?.intent === "style_tone") intent = "style_switch";
  else if (RECALL_RECENT.test(trimmed)) intent = "recall_recent";
  else if (SELECT_SECOND.test(trimmed) || SELECT_FIRST.test(trimmed))
    intent = "select_option";
  else if (FIX_REF.test(trimmed)) intent = "fix_ref";
  else if (WHY_HOW.test(trimmed)) intent = "clarify";
  else if (REFERENCE.test(trimmed)) intent = "reference";
  else if (GREETING.test(trimmed) && trimmed.length <= 40) intent = "greeting";

  const conversational = intent !== "task";
  const hasPrior = Boolean(snapshot.lastAssistant || snapshot.lastUser);

  return {
    intent,
    conversational,
    needsVerification: !conversational && EXPLICIT_VERIFY.test(trimmed),
    expandWithContext: conversational && hasPrior && intent !== "greeting",
    snapshot,
    selectKey: SELECT_SECOND.test(trimmed)
      ? "2"
      : SELECT_FIRST.test(trimmed)
        ? "1"
        : null,
    languageSwitch,
    semantic,
    styleCommand:
      styleCommand ||
      (arabicFollow?.intent === "style_tone"
        ? {
            kind: "tone_casual",
            continueTopic: true,
            patch: { tone: "casual", arabic_style: "jeddawi", language: "ar" },
          }
        : null),
    arabicFollow,
  };
}

/**
 * Full pre-routing resolution: effective intent + tool/memory/evidence policy.
 * @param {string} rawText
 * @param {{ history?: any[], user?: object, previousStyle?: object, previousTopic?: string|null, previousSecurityTarget?: object|null, store?: object|null }} [options]
 */
export function resolveTurnContext(
  rawText = "",
  {
    history = [],
    user,
    previousStyle = null,
    previousTopic = null,
    previousSpeakerPersona = null,
    previousSecurityTarget = null,
    store = null,
  } = {},
) {
  const trimmed = String(rawText || "").trim();
  const semantic = normalizeJeddawiSemantics(trimmed);
  const canonicalTopic = extractCanonicalTopic(trimmed, previousTopic);
  const styleBefore = normalizeConversationStyle(previousStyle);
  const earlyStyleCmd = classifyStyleCommand(trimmed);
  const styleAfter = earlyStyleCmd
    ? applyStylePatch(styleBefore, earlyStyleCmd.patch)
    : styleBefore;
  const speakerPersona = applySpeakerPersonaClaim(
    previousSpeakerPersona,
    trimmed,
    user,
    store,
  );
  const speakerPrompt = formatSpeakerPersonaPrompt(speakerPersona, styleAfter);

  const priority = classifyPriorityLane(trimmed, {
    user,
    style: styleAfter,
  });
  const priorityOverrides = priorityTurnOverrides(
    { ...priority, rawText: trimmed },
    { user, style: styleAfter },
  );
  if (priorityOverrides) {
    const snapshot = buildRecentContext(history, { canonicalTopic });
    snapshot.canonicalTopic = canonicalTopic;
    return {
      rawText: trimmed,
      snapshot,
      selectKey: null,
      needsVerification: false,
      explicitVerify: false,
      explicitRemember: false,
      priority,
      ...priorityOverrides,
      effectiveIntent:
        priority.lane === "persona"
          ? trimmed
          : priorityOverrides.effectiveIntent,
      conversationStyle: styleAfter,
      stylePrompt:
        formatConversationStylePrompt(styleAfter) +
        "\n" +
        formatSemanticUnderstandingPrompt({
          topic: canonicalTopic,
          semantic,
        }) +
        "\n" +
        formatFinalOutputContract(styleAfter) +
        "\n" +
        speakerPrompt,
      threadContext: formatCompactThreadContext(snapshot, {
        style: styleAfter,
      }),
      styleChanged: false,
      semantic,
      canonicalTopic,
      speakerPersona,
      instantGreeting: isPureGreeting(trimmed),
    };
  }

  const classified = classifyConversationIntent(rawText, { history });
  const snapshot =
    classified.snapshot ||
    buildRecentContext(history, { canonicalTopic });
  snapshot.canonicalTopic = canonicalTopic;
  snapshot.lastTopic = canonicalTopic || snapshot.lastTopic;
  const explicitRemember = EXPLICIT_REMEMBER.test(trimmed);
  const explicitVerify = EXPLICIT_VERIFY.test(trimmed);

  const styleCommand = classified.styleCommand || earlyStyleCmd;
  const conversationStyle = styleCommand
    ? applyStylePatch(styleBefore, styleCommand.patch)
    : styleBefore;
  const styleChanged = Boolean(styleCommand);

  let securityIntent = !classified.conversational
    ? classifySecurityIntent(trimmed)
    : null;
  if (securityIntent) {
    const currentFile = extractSecurityFileTarget(trimmed);
    if (
      !currentFile &&
      !securityIntent.argsHint?.path &&
      canReuseSecurityFileTarget(securityIntent) &&
      previousSecurityTarget?.path &&
      isSecurityTargetFollowUp(trimmed)
    ) {
      securityIntent = withSecurityTarget(securityIntent, {
        path: previousSecurityTarget.path,
        extension:
          previousSecurityTarget.extension ||
          securityBinaryExtension(previousSecurityTarget.path),
        explicit: false,
        reused: true,
      });
    }
    const securityTopic =
      securityIntent.argsHint?.path ||
      (securityIntent.argsHint?.pid != null
        ? `PID ${securityIntent.argsHint.pid}`
        : securityIntent.kind);
    const isolatedSnapshot = {
      lastAssistant: "",
      lastUser: trimmed,
      lastExecutableProposal: "",
      lastOptions: [],
      lastTopic: securityTopic,
      canonicalTopic: securityTopic,
      transientFacts: [],
      recentTurns: [],
      messages: [],
    };
    return {
      rawText: trimmed,
      effectiveIntent: securityIntent.effectiveIntent,
      directive: securityIntent.directive,
      intent: "task",
      conversational: false,
      expandWithContext: false,
      taskHint: securityIntent.kind,
      selectKey: null,
      snapshot: isolatedSnapshot,
      fastPath: false,
      allowResearch: false,
      allowVerification: false,
      allowMemoryWrite: false,
      allowRememberTool: false,
      allowWebSearch: false,
      allowMemoryRecall: false,
      needsVerification: false,
      explicitVerify: false,
      explicitRemember: false,
      resetTaskState: true,
      isolateSecurityContext: true,
      priorityLane: "normal",
      priority: { lane: "normal", reason: "security_toolkit" },
      securityIntent,
      conversationStyle,
      stylePrompt:
        formatConversationStylePrompt(conversationStyle) +
        "\n" +
        formatFinalOutputContract(conversationStyle) +
        "\n" +
        speakerPrompt,
      threadContext: "",
      styleChanged: false,
      semantic,
      canonicalTopic: securityTopic,
      speakerPersona,
      instantGreeting: false,
    };
  }

  // Structured Windows diagnostics beat free-form terminal invention.
  const pcDiag = !classified.conversational
    ? classifyPcDiagnosticIntent(trimmed)
    : null;
  if (pcDiag) {
    return {
      rawText: trimmed,
      effectiveIntent: pcDiag.effectiveIntent,
      directive: pcDiag.directive,
      intent: "task",
      conversational: false,
      expandWithContext: false,
      taskHint: pcDiag.kind,
      selectKey: null,
      snapshot,
      fastPath: false,
      allowResearch: false,
      allowVerification: false,
      allowMemoryWrite: false,
      allowRememberTool: false,
      allowWebSearch: false,
      allowMemoryRecall: false,
      needsVerification: false,
      explicitVerify: false,
      explicitRemember: false,
      resetTaskState: false,
      priorityLane: "normal",
      priority: { lane: "normal", reason: "pc_diagnostic" },
      diagnostic: pcDiag,
      conversationStyle,
      stylePrompt:
        formatConversationStylePrompt(conversationStyle) +
        "\n" +
        formatFinalOutputContract(conversationStyle) +
        "\n" +
        speakerPrompt,
      threadContext: formatCompactThreadContext(snapshot, {
        style: conversationStyle,
      }),
      styleChanged: false,
      semantic,
      canonicalTopic,
      speakerPersona,
      instantGreeting: isPureGreeting(trimmed),
    };
  }

  const {
    effectiveIntent,
    directive,
    taskHint,
    resetTaskState: intentResetTaskState = false,
  } = buildEffectiveIntent(
    trimmed,
    classified,
    snapshot,
    conversationStyle,
  );

  const followUp =
    classified.conversational &&
    [
      "confirm",
      "continue",
      "rewrite",
      "select_option",
      "fix_ref",
      "reference",
      "clarify",
      "reject",
      "greeting",
      "language_switch",
      "style_switch",
      "recall_recent",
    ].includes(classified.intent);

  const trivial =
    classified.intent === "greeting" ||
    (trimmed.length <= 64 &&
      /^(?:hi|hello|hey(?:\s+jack)?|yo|thanks|thank you|thx|ty|ok|okay|yea|yeah|yes|sure|continue|good\s*morning|good\s*afternoon|good\s*evening|how are you(?: doing)?|what's up|sup|the second(?: one)?|مرحبا|هلا|هاي|السلام عليكم|شكرا|شكراً|نعم|ايوه|تمام|اوك|كمل|الثاني|صباح الخير|مساء الخير|كيفك)[.!؟\s]*$/iu.test(
        trimmed,
      ) ||
      isPureGreeting(trimmed));

  const fastPath =
    trivial ||
    (followUp &&
      [
        "greeting",
        "confirm",
        "continue",
        "reject",
        "rewrite",
        "select_option",
        "language_switch",
        "style_switch",
        "recall_recent",
      ].includes(classified.intent) &&
      !explicitVerify &&
      !explicitRemember);

  const threadContext = formatCompactThreadContext(snapshot, {
    style: conversationStyle,
  });
  const stylePrompt = [
    formatConversationStylePrompt(conversationStyle),
    formatSemanticUnderstandingPrompt({
      topic: canonicalTopic,
      semantic,
      recentContext: snapshot.canonicalTopic
        ? `Prior assistant (do not copy): ${String(snapshot.lastAssistant || "").slice(0, 220)}`
        : "",
    }),
    formatFinalOutputContract(conversationStyle),
    speakerPrompt,
  ].join("\n");

  return {
    rawText: trimmed,
    effectiveIntent,
    directive,
    threadContext,
    stylePrompt,
    conversationStyle,
    styleChanged,
    intent: classified.intent,
    conversational: classified.conversational,
    expandWithContext: classified.expandWithContext,
    taskHint,
    selectKey: classified.selectKey,
    snapshot,
    fastPath,
    allowResearch: !followUp || explicitVerify,
    allowVerification:
      explicitVerify || (!followUp && !classified.conversational),
    allowMemoryWrite: !followUp || explicitRemember,
    allowRememberTool: !followUp || explicitRemember,
    allowWebSearch: !followUp || explicitVerify,
    allowMemoryRecall: !followUp,
    needsVerification: classified.needsVerification || explicitVerify,
    explicitVerify,
    explicitRemember,
    resetTaskState: Boolean(intentResetTaskState),
    priorityLane: "normal",
    priority,
    languageSwitch: classified.languageSwitch || null,
    styleCommand: styleCommand || null,
    semantic,
    canonicalTopic,
    speakerPersona,
    instantGreeting: isPureGreeting(trimmed),
  };
}

function buildEffectiveIntent(trimmed, classified, snapshot, style = null) {
  const proposal = snapshot.lastExecutableProposal || "";
  const priorAssistant = snapshot.lastAssistant || "";
  const priorUser = snapshot.lastUser || "";
  const options = snapshot.lastOptions || [];
  const thread = formatCompactThreadContext(snapshot, { style });
  const styleBlock = style ? formatConversationStylePrompt(style) : "";
  const arabicHint = classified.arabicFollow?.hint;

  const barePcUse =
    /^(?:use|control|access)\s+(?:my|the)\s+(?:pc|computer)(?:\s+to\s+do\s+it)?[.!?\s]*$/i.test(
      trimmed,
    ) ||
    /^(?:استخدم|استعمل|تحكم\s+في)\s+(?:جهازي|الكمبيوتر|البي\s*سي)[.!؟\s]*$/iu.test(
      trimmed,
    );
  if (barePcUse) {
    const priorObjective =
      priorUser || snapshot.canonicalTopic || snapshot.lastTopic || "";
    const priorIsSteam = /\bsteam\b|ستيم/iu.test(priorObjective);
    return {
      taskHint: priorIsSteam ? "steam_action" : "pc_action",
      effectiveIntent: priorObjective
        ? `Continue the previous concrete objective using the connected PC tools. Previous user objective: ${priorObjective}`
        : "Use the connected PC tools for the user's objective.",
      directive: [
        "OWNER PC ACTION: PC-control tools are connected and available.",
        priorObjective
          ? "Continue the immediately preceding objective using the appropriate enabled PC/browser/terminal/desktop tool. Do not claim you cannot access the PC."
          : "If no concrete objective exists, ask one short question for the objective. Do not claim you cannot access the PC.",
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
      resetTaskState: false,
    };
  }

  const steamAction =
    /\bsteam\b|ستيم/iu.test(trimmed) &&
    /\b(?:look\s+for|find|search|open|install|download|launch|run|check|locate)\b|(?:ابحث|دور|افتح|ثبت|حمّل|حمل|شغل|نزّل|نزل)/iu.test(
      trimmed,
    );
  if (steamAction) {
    const previousUserText = String(snapshot.lastUser || "");
    const priorSteamContext = /\bsteam\b|ستيم|\bgame\b|لعبة/iu.test(
      previousUserText,
    );
    return {
      taskHint: "steam_action",
      effectiveIntent: trimmed,
      directive: [
        "STEAM ACTION: treat this as an operational PC task, not a capability question.",
        "Use the dedicated steam tool first. For lookup/search, call steam action=search with the game name and use only a verified app_id returned by that tool.",
        "Never guess a Steam App ID. Never use steamcmd for store discovery.",
        "Use browser, terminal, files, or desktop only as a fallback after the steam tool reports an actual blocker. Do not claim Steam or PC access is unsupported while the steam tool is enabled.",
        /luatools/i.test(trimmed)
          ? "LuaTools was explicitly named. Inspect the local machine for LuaTools before claiming it is unavailable. If the requested path would bypass Steam ownership/licensing, use the official Steam client path instead and state that exact operational limitation."
          : "",
        "For installs/downloads, prefer the official Steam client and owned-library flow; verify what actually happened before claiming success.",
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
      resetTaskState: Boolean(previousUserText) && !priorSteamContext,
    };
  }

  if (classified.intent === "style_switch") {
    const cmd = classified.styleCommand;
    const kind = cmd?.kind || "style";
    const topic =
      snapshot.canonicalTopic ||
      snapshot.lastTopic ||
      priorAssistant.slice(0, 160) ||
      priorUser.slice(0, 160);
    return {
      taskHint: "style_switch",
      effectiveIntent: topic
        ? `Update presentation style (${kind}) and CONTINUE the active topic: ${topic}`
        : `Update conversation presentation style (${kind}). Do not invent a new topic.`,
      directive: [
        "STYLE / DIALECT DIRECTIVE — presentation only.",
        "Do NOT reset the active topic, transient facts, or unresolved questions.",
        topic
          ? `Stay on this topic in the new style: ${topic}`
          : "Acknowledge the style briefly if needed.",
        kind === "english"
          ? "Reply in English THIS TURN. Keep the CANONICAL TOPIC. Do NOT translate الزبدة as butter. Do NOT greet with 'At your service'."
          : kind === "jeddawi"
            ? [
                "Reply in natural Jeddawi Arabic script THIS TURN.",
                "Do NOT answer in English. Do NOT use stiff MSA.",
                "Do NOT narrate that you are speaking Jeddawi.",
                "Continue the CANONICAL TOPIC with a concrete answer — not a dialect announcement.",
                "Do not copy style demonstrations. Do not emit nonsense like روح واجبه.",
              ].join(" ")
            : kind === "msa"
              ? "Reply in MSA Arabic script THIS TURN. Do NOT answer in English. Continue the prior topic."
              : kind === "arabic"
                ? "Reply in Arabic script THIS TURN. Do NOT answer in English."
                : "",
        "No Egyptian dialect. No emoji. No canned helper phrases. No nonsense slang.",
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === "confirm") {
    if (proposal || arabicHint === "do_it") {
      return {
        taskHint: "confirm_action",
        effectiveIntent: proposal
          ? `Yes — continue/execute the immediately preceding proposal: ${proposal}`
          : "User confirmed — proceed with the active thread action.",
        directive: [
          "The user confirmed (yea/سويه/خلصني).",
          "Continue that exact thread. Do not start unrelated web research.",
          "Do not ask what they meant if the prior proposal is clear.",
          proposal ? `Prior proposal: ${proposal}` : "",
          styleBlock,
          thread,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      taskHint: "acknowledge",
      effectiveIntent:
        "User acknowledged the active conversational thread. Stay on the current topic; do not greet from scratch.",
      directive: [
        "The user said yea/yes as an acknowledgement in the CURRENT thread.",
        "Do NOT reply with a fresh greeting like 'At your service, Master.'",
        "Respond briefly in-thread using recent context and transient facts.",
        "Do not start web research or tools.",
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === "continue") {
    const action = proposal || priorAssistant.slice(0, 280);
    return {
      taskHint: "continue",
      effectiveIntent:
        arabicHint === "what_now" || classified.semantic?.kind === "what_now"
          ? `User asks what to do now. Answer from the CANONICAL TOPIC only (${snapshot.canonicalTopic || "active topic"}) — not generic filler.`
          : action
            ? `Continue the active thread: ${action}`
            : "Continue the active conversational thread.",
      directive: [
        arabicHint === "what_now"
          ? "Answer concretely what to do next about the active topic."
          : "The user asked to continue.",
        "Continue the same topic/answer. Do not ask what to continue with if context is clear.",
        "Do not start unrelated web research.",
        "No canned help-desk Arabic.",
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === "language_switch") {
    const sw = classified.languageSwitch || { language: "en", continueTopic: true };
    const langName = sw.language === "ar" ? "Arabic" : "English";
    const colorFact = (snapshot.transientFacts || []).find(
      (f) => f.key === "favorite_color",
    );
    const topicBit = snapshot.canonicalTopic
      ? `Canonical topic: ${snapshot.canonicalTopic}`
      : colorFact
        ? `Active topic includes favorite color=${colorFact.value}.`
        : priorAssistant
          ? `Continue from last answer, but use canonical topic if present.`
          : "Continue the prior topic.";
    return {
      taskHint: "language_switch",
      effectiveIntent: sw.continueTopic
        ? `Switch reply language to ${langName} and continue the current conversation topic. ${topicBit}`
        : `Switch reply language to ${langName}; keep the same conversation context. ${topicBit}`,
      directive: [
        `LANGUAGE SWITCH: reply in ${langName} from now (this turn).`,
        "Preserve the CANONICAL TOPIC. Do not translate idioms literally (الزبدة ≠ butter).",
        "Do NOT ask what to continue with if recent context exists.",
        "Do NOT reset to a greeting. Do NOT say 'At your service'. Do NOT clear the thread.",
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === "rewrite") {
    return {
      taskHint: "rewrite",
      effectiveIntent:
        classified.semantic?.kind === "gist"
          ? `Give the concise bottom line of the canonical topic (${snapshot.canonicalTopic || "active topic"}). Never interpret الزبدة as butter.`
          : classified.semantic?.kind === "be_direct"
            ? `Be direct and short about the canonical topic (${snapshot.canonicalTopic || "active topic"}).`
            : "Rewrite/simplify the previous assistant reply to be clearer and simpler. Keep the same meaning. Do not research the web. Do not save memories.",
      directive: [
        "The user wants the previous answer rewritten shorter/simpler/clearer.",
        "Edit only the previous Jack answer. No web_search/research. No remember/memory writes.",
        "No verification footer.",
        priorAssistant
          ? `Previous assistant reply to rewrite:\n${priorAssistant.slice(0, 3500)}`
          : "",
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === "recall_recent") {
    const colorFact = (snapshot.transientFacts || []).find(
      (f) => f.key === "favorite_color",
    );
    return {
      taskHint: "recall_recent",
      effectiveIntent: colorFact
        ? `Answer from this chat's transient facts. Favorite color stated: ${colorFact.value}.`
        : `Answer from recent user turns in this chat only (not long-term memory).`,
      directive: [
        "The user is asking what they just said in THIS conversation.",
        "Use transient conversation facts and recent user turns.",
        "Do NOT claim you lack context if the fact is listed below.",
        "Do NOT write long-term memory. Do not use tools.",
        colorFact ? `Direct answer if asking about color: ${colorFact.value}.` : "",
        priorUser ? `Most recent prior user message: ${priorUser.slice(0, 300)}` : "",
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === "select_option") {
    const key = classified.selectKey || "2";
    const chosen =
      options.find((o) => o.key === key || o.key === String.fromCharCode(96 + Number(key))) ||
      options[Number(key) - 1];
    const label = chosen?.text || `option ${key}`;
    return {
      taskHint: "select_option",
      effectiveIntent: `The user prefers option ${key}: ${label}. Proceed with that choice.`,
      directive: [
        `The user selected option ${key} from your previous comparison.`,
        `Chosen: ${label}`,
        "Do not run web research. Acknowledge and continue with that option.",
        options.length
          ? `Available options were:\n${options.map((o, i) => `${i + 1}. ${o.text}`).join("\n")}`
          : priorAssistant.slice(0, 2000),
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === "fix_ref" || classified.intent === "reference") {
    return {
      taskHint: "reference",
      effectiveIntent: `Regarding the previous turn (${proposal || snapshot.lastTopic}): ${trimmed}`,
      directive: [
        "Resolve this short follow-up against the prior turn.",
        "Do not treat it as a new standalone research query.",
        priorAssistant.slice(0, 2000),
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === "clarify") {
    return {
      taskHint: "clarify",
      effectiveIntent:
        arabicHint === "fallback_if_fails" ||
        classified.semantic?.kind === "if_fails"
          ? `User asks what if the plan fails. Answer against CANONICAL TOPIC (${snapshot.canonicalTopic || "active topic"}) with a concrete fallback.`
          : `${trimmed} (about the previous assistant reply)`,
      directive: [
        arabicHint === "fallback_if_fails"
          ? "Give a practical backup for the active plan. Stay on topic."
          : "Answer the short clarification about your previous reply.",
        "No new web research unless they explicitly ask to research.",
        "No generic filler.",
        priorAssistant.slice(0, 2000),
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === "reject") {
    return {
      taskHint: "reject",
      effectiveIntent: "The user rejected the previous proposal. Stop that plan and wait for new direction.",
      directive: "User rejected the previous proposal. Do not execute it. Ask briefly what they prefer instead if needed.",
    };
  }

  if (classified.intent === "greeting") {
    return {
      taskHint: "greeting",
      effectiveIntent: trimmed,
      directive: styleBlock || "",
    };
  }

  if (priorAssistant || priorUser || (snapshot.transientFacts || []).length) {
    return {
      taskHint: null,
      effectiveIntent: trimmed,
      directive: [
        "Use ACTIVE THREAD context below for pronouns and recent facts.",
        "Transient conversation facts are chat-scoped — not long-term memory.",
        styleBlock,
        thread,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return {
    taskHint: null,
    effectiveIntent: trimmed,
    directive: styleBlock || "",
  };
}

/**
 * Back-compat helper used by older tests / callers.
 */
export function contextualizeUserText(text, history = [], intent) {
  if (intent?.expandWithContext === false) return String(text || "").trim();
  const resolved = resolveTurnContext(text, { history });
  return resolved.directive
    ? `${resolved.effectiveIntent}\n\n${resolved.directive}`
    : resolved.effectiveIntent;
}

/**
 * Whether the verification footer should run for THIS turn.
 * Evidence must already be turn-scoped by the caller.
 */
export function shouldAttachVerification({
  intent,
  text = "",
  evidencePack = null,
  explicitVerify = false,
  allowVerification = true,
  turnScoped = true,
} = {}) {
  if (!turnScoped) return false;
  if (explicitVerify) {
    return Boolean(
      evidencePack?.research?.sources?.length ||
        evidencePack?.tests ||
        evidencePack?.meaningful,
    );
  }
  if (allowVerification === false) return false;
  if (intent?.conversational && !intent?.needsVerification) return false;
  if (intent && intent.allowVerification === false) return false;
  const trimmed = String(text || "").trim();
  if (
    CONFIRM.test(trimmed) ||
    CONTINUE.test(trimmed) ||
    REWRITE.test(trimmed) ||
    SELECT_FIRST.test(trimmed) ||
    SELECT_SECOND.test(trimmed) ||
    GREETING.test(trimmed)
  )
    return false;
  if (!evidencePack?.meaningful) return false;
  // Only attach synthesizable CURRENT-turn verification facts.
  return Boolean(
    evidencePack.tests ||
      evidencePack.research?.sources?.length ||
      evidencePack.changedFiles?.length,
  );
}

const SECURITY_TOOL_COMPANIONS = Object.freeze({
  // Explicit security intents expose only the intended tool unless a
  // workflow later declares a small companion set here.
});

export function lockedSecurityTools(turn) {
  const tool = turn?.securityIntent?.tool;
  if (!tool) return null;
  const extras = SECURITY_TOOL_COMPANIONS[tool];
  return extras?.length ? [tool, ...extras] : [tool];
}

function parseToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * When a security intent names a tool, that tool is authoritative.
 * Drop unrelated security/process/network/terminal calls and inject argsHint.
 */
export function applyAuthoritativeSecurityTool(
  response,
  securityIntent,
  { invoked = false } = {},
) {
  if (!securityIntent?.tool || invoked) return response;
  const required = securityIntent.tool;
  const hint =
    securityIntent.argsHint && typeof securityIntent.argsHint === "object"
      ? { ...securityIntent.argsHint }
      : {};
  const calls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
  const requiredCall = calls.find(
    (call) => (call.function?.name || call.name) === required,
  );
  const args = {
    ...hint,
    ...parseToolArguments(requiredCall?.function?.arguments ?? requiredCall?.arguments),
  };
  if (hint.path) args.path = hint.path;
  if (hint.pid != null) args.pid = hint.pid;
  return {
    ...response,
    tool_calls: [
      {
        ...(requiredCall || {}),
        function: {
          ...(requiredCall?.function || {}),
          name: required,
          arguments: args,
        },
      },
    ],
  };
}

/**
 * Filter tool definitions for this turn's policy.
 */
export function filterToolsForTurn(definitions = [], turn) {
  if (!turn) return definitions;
  const locked = lockedSecurityTools(turn);
  return definitions.filter((def) => {
    const name = def?.function?.name || def?.name;
    if (locked) return locked.includes(name);
    if (
      turn.taskHint === "steam_action" &&
      !["steam", "consult_expert", "browser", "desktop"].includes(name)
    )
      return false;
    if (!turn.allowResearch && (name === "research" || name === "web_search"))
      return false;
    if (!turn.allowRememberTool && name === "remember") return false;
    if (
      String(turn.taskHint || "").startsWith("security_") &&
      name === "terminal"
    )
      return false;
    return true;
  });
}

/**
 * Keep only events created during the current agent turn.
 */
export function eventsForCurrentTurn(allEvents = [], { chatId, afterId = 0, sinceIso = null } = {}) {
  return (allEvents || []).filter((e) => {
    if (chatId && e.chat_id !== chatId && e.chatId !== chatId) return false;
    if (afterId != null && Number(e.id) <= Number(afterId)) return false;
    if (sinceIso && e.created && String(e.created) < String(sinceIso))
      return false;
    return true;
  });
}

export function latestEventId(events = []) {
  let max = 0;
  for (const e of events || []) {
    const id = Number(e.id) || 0;
    if (id > max) max = id;
  }
  return max;
}
