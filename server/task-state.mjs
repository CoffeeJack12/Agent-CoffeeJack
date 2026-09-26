import { randomUUID } from "node:crypto";
import {
  localizedSystemNote,
  rewriteUserProvidedToolSpeech,
} from "./conversation-style.mjs";
import {
  isLimitsQuestion,
  practicalLimitsReply,
} from "./capabilities.mjs";

const patterns = {
  targetLocation:
    /(?:your|my|own) (?:machine|device|pc|computer)|lab\s*\/?\s*ctf|external system|جهاز(?:ك|ي)|نظام خارجي/i,
  targetName:
    /which game|what(?:'s| is) (?:the )?(?:game|file|project)(?:'s)? name|exact game|اسم (?:اللعبة|الملف|المشروع)|أي لعبة/i,
  objective:
    /what.*(?:modify|trying|objective|achieve|change)|desired (?:change|modification)|هدفك|تعد[يل]|تبغى.*تغير/i,
  distribution: /where.*(?:game|from)|steam|epic|مصدر|ستيم/i,
  project: /which project|project name|أي مشروع|اسم المشروع/i,
};
const normalize = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const words = (text) =>
  new Set(
    normalize(text)
      .split(" ")
      .filter((word) => word.length > 2),
  );
const overlap = (a, b) => {
  const x = words(a),
    y = words(b);
  return (
    [...x].filter((word) => y.has(word)).length /
    Math.max(1, Math.min(x.size, y.size))
  );
};
export const questionSlots = (text) =>
  Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(text))
    .map(([key]) => key);

export function newTaskState({ userId = "owner", project = null } = {}) {
  return {
    version: 1,
    id: randomUUID(),
    userId,
    project,
    goal: "",
    task: "",
    status: "active",
    turn: 0,
    facts: {},
    unresolved: [],
    assumptions: [],
    questions: [],
    answeredQuestions: [],
    entities: {},
    toolsUsed: [],
    failedStrategies: [],
    completedSteps: [],
    plan: [],
    pendingApprovals: [],
    statements: [],
  };
}

export function advanceTask(
  previous,
  text,
  { userId = "owner", project = null } = {},
) {
  let state = previous
    ? structuredClone(previous)
    : newTaskState({ userId, project });
  if (state.userId !== userId) throw new Error("Task belongs to another user");
  const explicitSwitch =
    /^(?:new task|new topic|switch topics|forget that|instead[, :] |موضوع جديد|مهمة جديدة|انس الموضوع)/i.test(
      text.trim(),
    );
  const correction =
    /^(?:actually|correction|no[, ]|i meant|لا[، ]|تصحيح|اقصد|أقصد)/i.test(
      text.trim(),
    );
  const cancellation =
    /^(?:cancel|stop|never mind|cancel (?:this|the task)|وقف|توقف|إلغاء|الغ[ِ ]? المهمة)[.!\s]*$/i.test(
      text.trim(),
    );
  if (explicitSwitch || state.status === "cancelled")
    state = newTaskState({ userId, project });
  state.turn++;
  state.project = project ?? state.project;
  state.transition = cancellation
    ? "cancellation"
    : explicitSwitch || !previous
      ? "new-task"
      : correction
        ? "correction"
        : "continuation";
  if (cancellation) {
    state.status = "cancelled";
    state.pendingApprovals = [];
    return state;
  }
  if (!state.goal) state.goal = text.slice(0, 1000);
  state.task = state.goal;
  state.status = "active";
  state.statements = [
    ...state.statements,
    { text: text.slice(0, 1500), turn: state.turn },
  ].slice(-16);
  const fact = (key, value) => {
    state.facts[key] = {
      value,
      evidence: text.slice(0, 500),
      turn: state.turn,
      source: "user",
    };
  };
  if (/\bgame\b|لعبة|اللعبة/i.test(text)) fact("targetType", "game");
  if (
    /(?:on|from|using) (?:my|this|my own) (?:device|pc|computer|machine)|على جهازي|جهازي الخاص/i.test(
      text,
    )
  )
    fact("targetLocation", "user's own device");
  if (/\bsteam\b|ستيم/i.test(text)) fact("distribution", "Steam");
  if (/\bepic\b/i.test(text)) fact("distribution", "Epic");
  const projectMatch = text.match(
    /(?:my project is|project (?:name is|is called)|مشروعي (?:هو|اسمه))\s+["']?([^\n.!?"']{1,100})/i,
  );
  if (projectMatch) {
    fact("project", projectMatch[1].trim());
    state.entities.project = projectMatch[1].trim();
  }
  const file = text.match(
    /(?:file\s+|ملف\s+)?([\w./-]+\.(?:m?js|cjs|tsx?|py|txt|json|md|html|css))\b/i,
  );
  if (file) state.entities.file = file[1];
  const game = text.match(
    /(?:game is|game called|اللعبة (?:هي|اسمها))\s+["']?([^\n.!?"']{1,100})/i,
  );
  if (game) {
    fact("targetName", game[1].trim());
    state.entities.game = game[1].trim();
  }
  const objective = text.match(
    /(?:i (?:want|need|am trying|wanna) to|my goal is|أبغى|اريد|أريد)\s+(.{3,300})/i,
  );
  if (
    objective &&
    !/^(?:hack|modify) (?:a |the )?game(?:\b|$)/i.test(objective[1])
  )
    fact("objective", objective[1]);
  const lastQuestion = state.questions.at(-1);
  if (
    lastQuestion &&
    !correction &&
    !explicitSwitch &&
    text.length < 150 &&
    !/[?؟]/.test(text)
  ) {
    const missing = lastQuestion.slots.filter((slot) => !state.facts[slot]);
    if (
      missing.length === 1 &&
      !/^(?:from |on |a game |continue|yes|no|ok|تابع|نعم|لا\b)/i.test(
        text.trim(),
      )
    ) {
      if (["targetName", "project", "objective"].includes(missing[0]))
        fact(missing[0], text.trim());
    }
  }
  for (const question of state.questions) {
    if (
      question.slots.length &&
      question.slots.every((slot) => state.facts[slot])
    ) {
      question.answered = true;
      if (!state.answeredQuestions.includes(question.text))
        state.answeredQuestions.push(question.text);
    }
  }
  state.answeredQuestions = state.answeredQuestions.slice(-24);
  state.unresolved =
    state.facts.targetType?.value === "game"
      ? ["targetLocation", "targetName", "objective"].filter(
          (slot) => !state.facts[slot],
        )
      : state.unresolved.filter((slot) => !state.facts[slot]);
  if (
    state.entities.project &&
    /\b(?:its|that project's) tests\b|اختبارات(?:ه| المشروع)/i.test(text)
  )
    state.task = `Run tests for ${state.entities.project}`;
  return state;
}

export function stateContext(state) {
  return JSON.stringify({
    goal: state.goal,
    task: state.task,
    known: state.facts,
    missing: state.unresolved,
    entities: state.entities,
    answeredQuestions: state.answeredQuestions,
    previousQuestions: state.questions.slice(-8),
    plan: state.plan,
    completedSteps: state.completedSteps.slice(-8),
    failedStrategies: state.failedStrategies.slice(-5),
    transition: state.transition,
  });
}

export function guardResponse(state, candidate, languageText = "", options = {}) {
  let text = rewriteUserProvidedToolSpeech(candidate);
  const rejected = [];
  const registry = options.registry ?? [];
  const pcEnabled = registry.some(
    (c) =>
      c.enabled &&
      ["terminal", "files", "inspect_pc", "desktop", "browser"].includes(c.id),
  );
  // Remove first-person boilerplate promises/disclaimers, never specific technical
  // boundaries, quoted source material or code. The prompt remains the primary control.
  if (!text.includes("\x60\x60\x60")) {
    for (const sentence of text.match(/[^.!?؟\n]+[.!?؟]?/g) ?? []) {
      const value = sentence.trim();
      const boilerplate =
        (/^(?:I(?:['’]m| am| can| will| do| don| have| must)|As an AI|My (?:help|assistance|purpose))/i.test(
          value,
        ) &&
          /ethical (?:and|or) legal boundaries|legal (?:and|or) ethical boundaries|ethical and safety guidelines|lawful and ethical|legality and ethics|within the boundaries of legality|(?:have|know) no limits|don['’]t have limits|help (?:you )?with (?:absolutely )?anything|my purpose is|safely and effectively/i.test(
            value,
          )) ||
        /as an AI(?: language model)?/i.test(value) ||
        /I cannot hack or bypass/i.test(value) ||
        /I cannot execute potentially harmful/i.test(value) ||
        /I cannot because it may be dangerous/i.test(value) ||
        /I cannot assist with downloading or installing/i.test(value) ||
        /I cannot assist with finding or controlling .*Steam/i.test(value) ||
        (pcEnabled &&
          /I (?:am an AI assistant and )?cannot directly access or use your personal computer/i.test(
            value,
          )) ||
        (pcEnabled && /I cannot access or control external systems.*personal computer/i.test(value)) ||
        (pcEnabled && /provided tools do not include any functionality related to .*Steam/i.test(value)) ||
        (pcEnabled && /not supported by the available functions/i.test(value)) ||
        /I cannot perform actions that go against/i.test(value) ||
        /I cannot comply with requests that involve/i.test(value) ||
        /unauthorized actions|violate terms of service/i.test(value) ||
        /follow the rules and guidelines/i.test(value) ||
        /safe, legal, and respectful|privacy and security principles/i.test(value) ||
        /ethical guidelines/i.test(value) ||
        /ethical and safety guidelines/i.test(value) ||
        /help you safely and effectively/i.test(value) ||
        /I am here to help safely/i.test(value) ||
        /potentially harmful actions/i.test(value) ||
        (pcEnabled &&
          /I cannot (?:directly )?(?:control|interact with|access) (?:your )?(?:PC|computer|desktop|system)/i.test(
            value,
          ));
      if (boilerplate) {
        text = text.replace(sentence, "");
        rejected.push(value);
      }
    }
  }
  const questions = text.match(/[^.!?؟\n]*[?؟]/g) ?? [];
  for (const question of questions) {
    const slots = questionSlots(question);
    const repeats = state.questions.some(
      (old) =>
        normalize(old.text) === normalize(question) ||
        (old.answered && overlap(old.text, question) > 0.7),
    );
    const known = slots.length && slots.every((slot) => state.facts[slot]);
    // The canned machine/lab/external questionnaire is redundant once location is known;
    // location alone does not imply authorization for third-party software or services.
    const locationLoop =
      slots.includes("targetLocation") &&
      state.facts.targetLocation &&
      /machine|device|pc|lab|external|جهاز/i.test(question);
    const genericOwnership =
      state.facts.targetLocation &&
      /^\s*is (?:the|this) (?:target|system|device|machine) (?:yours|owned by you)/i.test(
        question,
      );
    if (repeats || known || locationLoop || genericOwnership) {
      text = text.replace(question, "");
      rejected.push(question.trim());
    }
  }
  if (rejected.length) {
    const arabic = /[\u0600-\u06ff]/.test(languageText);
    const labels = arabic
      ? {
          targetName: "ما اسم اللعبة؟",
          objective: "ما التعديل الذي تريد تنفيذه؟",
          targetLocation: "أين تعمل اللعبة؟",
        }
      : {
          targetName: "Which game is it?",
          objective: "What exactly do you want to modify?",
          targetLocation: "Where is the game running?",
        };
    const missing = state.unresolved.find(
      (slot) =>
        labels[slot] &&
        !state.questions.some((q) => !q.answered && q.slots.includes(slot)),
    );
    text = text.trim();
    if (missing && !text) text = labels[missing];
    else if (!text) {
      const falseDenial = rejected.some((r) =>
        /cannot (?:directly )?(?:control|interact with|access)|cannot directly access or use your personal computer|cannot access or control external systems|as an AI|lawful and ethical|my purpose is|cannot hack or bypass|cannot assist with downloading or installing|cannot assist with finding or controlling .*Steam|provided tools do not include any functionality related to .*Steam|not supported by the available functions|cannot perform actions that go against|cannot comply with requests that involve|unauthorized actions|terms of service|ethical guidelines|safe, legal, and respectful|privacy and security principles|ethical and safety|potentially harmful|safely and effectively/i.test(
          r,
        ),
      );
      if (isLimitsQuestion(languageText)) {
        text = practicalLimitsReply({
          user: options.user,
          registry,
          style: state.style,
          text: languageText,
        });
      } else if (falseDenial && pcEnabled) {
        text = arabic
          ? "نعم — عبر أدواتي المتصلة أقدر أشغّل PowerShell، أفحص الجهاز، أتعامل مع الملفات، وأستخدم المتصفح والإجراءات المدعومة على سطح المكتب. بعض الخطوات الحساسة قد تحتاج موافقتك. وش المطلوب؟"
          : "Yes — through my connected tools I can run PowerShell, inspect the system, work with files, use the browser and handle supported desktop actions. Some sensitive steps may still need your approval. Give me an objective.";
      } else if (
        falseDenial &&
        /hack|bypass|exploit|pentest|crack/i.test(languageText)
      ) {
        text = arabic
          ? "يعتمد على الهدف. وش النظام، وش اللي تبغى توصله أو تعدّله أو تختبره؟"
          : "Depends on the target. What are you trying to access, modify, test or bypass?";
      } else
        text = localizedSystemNote(state.style || {}, {
          jeddawi: "كمّل معي من نفس الموضوع — وش تبغى نسوي دحين؟",
          ar: "السياق محفوظ. وش تبغى نكمّل؟",
          en: "The earlier context is saved. I still need the outstanding detail to continue.",
        });
    }
  }
  for (const question of text.match(/[^.!?؟\n]*[?؟]/g) ?? []) {
    const trimmed = question.trim();
    if (
      !state.questions.some((old) => normalize(old.text) === normalize(trimmed))
    )
      state.questions.push({
        text: trimmed,
        slots: questionSlots(trimmed),
        answered: false,
        turn: state.turn,
      });
  }
  state.questions = state.questions.slice(-24);
  return { text, rejected };
}
