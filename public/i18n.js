/** CoffeeJack UI i18n — en / ar dictionaries and DOM helpers. */

export const dictionaries = {
  en: {
    // Brand & sidebar
    "brand.tagline": "COFFEEJACK / LOCAL INTELLIGENCE",
    "nav.workspace": "Your space",
    "nav.chat": "Chat",
    "nav.memory": "Memory",
    "nav.activity": "Activity log",
    "nav.persona": "Jack persona",
    "nav.settings": "Settings",
    "nav.newChat": "New chat",
    "nav.newChatShortcut": "Ctrl K",
    "nav.history": "Recent chats",
    "sidebar.private.title": "On your machine. Yours alone.",
    "sidebar.private.detail": "Memory and chats are stored locally",
    "sidebar.profile.workspace": "Personal workspace",

    // Header
    "header.workspace": "JACK WORKSPACE",
    "header.themeToggle": "Toggle theme",
    "header.newChat": "New chat",

    // Page titles
    "page.chat": "Chat",
    "page.memory": "Memory",
    "page.activity": "Activity log",
    "page.settings": "Settings",
    "page.persona": "Jack persona",

    // Connection & gaming
    "connection.connecting": "Connecting…",
    "connection.local": "Connected locally",
    "connection.modelNotReady": "Model not ready",
    "connection.disconnected": "Disconnected",
    "connection.gamingPriority": "Games first",
    "gaming.mode": "Gaming mode",
    "gaming.modeOn": "Gaming mode on",
    "gaming.notice":
      "Gaming mode is on; Jack tasks are paused and models are unloaded from memory.",

    // Welcome
    "welcome.kicker": "LOCAL INTELLIGENCE. YOUR COMMAND.",
    "welcome.presence.here": "Jack is here",
    "welcome.presence.working": "Jack is working on your request",
    "welcome.presence.gaming": "Jack is in gaming mode",
    "welcome.headline.line1": "Think bigger.",
    "welcome.headline.line2": "Leave execution to me.",
    "welcome.body.line1": "I'm Jack. I inspect, build, and verify the result.",
    "welcome.body.line2": "Your extra mind. On your machine. Under your control.",
    "welcome.suggest.build.title": "Let's build something",
    "welcome.suggest.build.detail": "A site, app, or new idea",
    "welcome.suggest.search.title": "Search with me",
    "welcome.suggest.search.detail": "Clearer information, from the source",
    "welcome.suggest.mood.title": "Change the mood",
    "welcome.suggest.mood.detail": "A little humor, a lighter start",

    // Composer
    "composer.placeholder": "Message Jack...",
    "composer.ariaLabel": "Your message to Jack",
    "composer.send": "Send",
    "composer.stop": "Stop",
    "composer.attach": "Attach file",
    "composer.taskType": "Task type",
    "composer.jackMode": "Jack mode",
    "composer.currentMode": "Current mode",
    "composer.footnote": "Local-first · Tools under your control · Enter to send",
    "composer.thinking": "Jack is preparing a reply…",
    "composer.status.thinking": "Jack is thinking…",
    "composer.status.working": "Jack is working · Step {round}",
    "composer.status.done": "Reply complete · On your device",
    "composer.jumpBottom": "↓ Latest reply",
    "composer.modelLocal": "Local",
    "composer.modelFallback": "Local fallback",

    // Legacy composer mode labels (task type select)
    "composer.mode.auto": "Auto",
    "composer.mode.general": "Conversation",
    "composer.mode.coding": "Coding",
    "composer.mode.vision": "Vision",

    // Chat actions
    "chat.copyCode": "Copy code",
    "chat.copyReply": "Copy reply",
    "chat.copied": "Copied ✓",
    "chat.copyFailed": "Copy failed",
    "chat.deleteChat": "Delete chat",
    "chat.deleteConfirm": "Delete this chat?",
    "chat.stopFirst": "Stop the current task first.",
    "chat.searchPlaceholder": "Search your chats…",
    "chat.searchAria": "Search chats",
    "chat.historyEmpty": "A fresh start,\nand many ideas waiting.",

    // Tool & approval states
    "tool.running": "Running",
    "tool.done": "Done",
    "tool.error": "Failed",
    "tool.screenshotAlt": "Tool screenshot",
    "approval.title": "Jack needs your approval: {name}",
    "approval.allow": "Run this step",
    "approval.deny": "Deny",

    // Notices
    "notice.engineOffline":
      "Local AI engine is offline. Start CoffeeJack from Start CoffeeJack.",
    "notice.modelMissing":
      "The selected model is not installed yet. Finish downloading or pick an available model in Settings.",
    "notice.uploadMaxSize": "Maximum file size is 20 MB.",
    "notice.uploadMaxCount": "Maximum 5 files.",
    "notice.requestFailed": "Request failed",

    // Memory
    "memory.eyebrow": "A LITTLE CONTEXT GOES A LONG WAY",
    "memory.title": "Things worth remembering.",
    "memory.intro":
      "Your preferences, decisions, and lessons we've learned. Add or remove them anytime.",
    "memory.placeholder": "e.g. I prefer explanations in Arabic with practical examples",
    "memory.save": "Save to memory",
    "memory.deleteAria": "Delete memory",
    "memory.empty": "Memory starts with you. Add your first preference or note.",
    "memory.preferences": "Preferences",
    "memory.lessons": "Lessons",
    "memory.aboutMe": "About me",
    "memory.environment": "Environment",
    "memory.projects": "Projects",
    "memory.kind.preference": "Preference",
    "memory.kind.lesson": "Lesson",
    "memory.kind.note": "Note",

    // Activity
    "activity.eyebrow": "EVERY STEP, IN THE OPEN",
    "activity.title": "You know exactly what happened.",
    "activity.intro":
      "Every tool Jack used and its result, stored here on your device.",
    "activity.refresh": "Refresh log ↻",
    "activity.empty": "No execution steps yet. Tools and results will appear here.",

    // Persona
    "persona.eyebrow": "MEET THE MIND BEHIND THE MUG",
    "persona.title.line1": "A steady persona.",
    "persona.title.line2": "Your way.",
    "persona.intro":
      "Sharp, practical, and grounded. Dark humor when it fits — results without theatrics.",
    "persona.tabsAria": "Persona presets",
    "persona.preset.playful": "☕ Coffee companion",
    "persona.preset.focused": "⌘ Focus time",
    "persona.preset.calm": "◌ Easygoing",
    "persona.speechStyle": "Way of speaking",
    "persona.replyLanguage": "Reply language",
    "persona.dialect": "Arabic style",
    "persona.humor": "Humor level",
    "persona.detail": "Reply length",
    "persona.save": "Save Jack persona",
    "persona.previewEyebrow": "A LITTLE TASTE",
    "persona.previewTitle": "How Jack might reply",
    "persona.previewNote":
      "A tone example, not a generated reply. Style adapts to the situation.",
    "persona.principle.sharp": "◈ Sharp and honest",
    "persona.principle.loyal": "◇ Loyal to you",
    "persona.principle.verify": "◎ Verifies before claiming",
    "persona.savePrompt": "Save to apply changes to future replies.",
    "persona.saved": "Saved. This is my style from now on ✓",
    "persona.dialect.jeddah": "Saudi / natural Jeddawi",
    "persona.dialect.standard": "Clear Modern Standard Arabic",
    "persona.humor.playful": "Wry — smart and dark when it fits",
    "persona.humor.subtle": "Light dry touch",
    "persona.humor.off": "No humor",
    "persona.detail.concise": "Short and useful",
    "persona.detail.balanced": "As much as needed",
    "persona.detail.thorough": "Detailed with examples",
    "persona.previewQuestion.en": "Jack, my code broke.",
    "persona.previewQuestion.ar.standard": "Jack, the code stopped working.",
    "persona.previewQuestion.ar.jeddah": "Jack, the code broke.",
    "persona.shortcut.playful": "Sharp, witty when needed",
    "persona.shortcut.subtle": "Calm, with a light edge",
    "persona.shortcut.off": "Focused on results",
    "persona.self.eyebrow": "GROUNDED IN WHAT ACTUALLY HAPPENED",
    "persona.self.title": "Knows context, accounts for its steps.",
    "persona.self.state.ready": "Ready",
    "persona.self.state.working": "Working on your request",
    "persona.self.state.gaming": "Game priority",
    "persona.self.memories": "memories saved",
    "persona.self.conversations": "conversations",
    "persona.self.tools": "successful tool steps",
    "persona.self.reflectionEmpty":
      "The result of your last request will appear here after it runs.",
    "persona.self.reflection":
      "Last request: {result} · {successfulTools} tools succeeded · {failedTools} tool errors · {durationSeconds}s. These are actual execution results, not inner thoughts.",
    "persona.self.outcome.completed": "Reply completed",
    "persona.self.outcome.cancelled": "Stopped at your request",
    "persona.self.outcome.error": "Stopped due to error",
    "persona.self.outcome.stepLimit": "Reached step limit",
    "persona.awareness.summary": "What does «self-aware» mean here?",
    "persona.awareness.body":
      "Jack has a stable identity and instructions, editable memory, and summaries built from tool results. This is functional awareness of context and limits — not a claim of human consciousness or feelings. It does not act on its own between your requests.",

    // Settings
    "settings.eyebrow": "MAKE YOURSELF AT HOME",
    "settings.title": "Jack, your way.",
    "settings.intro":
      "Models, workspace, and memory run on your device. Internet services are used only when you request web tools.",
    "settings.formAria": "Jack preferences",
    "settings.localMind": "Local mind",
    "settings.primaryModel": "Primary model",
    "settings.codingModel": "Coding model",
    "settings.visionModel": "Vision model",
    "settings.visionHint":
      "Pick a vision-capable model for image and screen analysis. Model list comes from Ollama.",
    "settings.sameAsPrimary": "Same as primary model",
    "settings.workspaceCard": "Workspace",
    "settings.workspaceFolder": "Folder where Jack creates projects",
    "settings.instructions": "Your style and preferences",
    "settings.instructionsPlaceholder": "How do you want Jack to help you?",
    "settings.toolsCard": "Tools & permissions",
    "settings.autoApprove": "Auto-run tools",
    "settings.autoApproveHint":
      "When enabled, Jack runs writes, commands, and control without per-step confirmation. System commands can access outside the project folder. You can stop a task anytime.",
    "settings.gamingCard": "Gaming priority",
    "settings.autoGaming": "Enable gaming mode automatically",
    "settings.gameProcesses": "Game process names, comma-separated",
    "settings.gamingHint":
      "Checks listed games every 15 seconds, stops tasks and unloads models. When the game closes, Jack is ready for your next request.",
    "settings.save": "Save settings",
    "settings.saved": "Settings saved.",
    "settings.branding": "Branding / Identity",
    "settings.brandingBody":
      "Replace approved assets in public/jack/avatar.png, icon.png, or logo.png. A J monogram appears until then.",
    "settings.voiceNote":
      "Voice is not installed. Startup remains controlled by your CoffeeJack launcher.",

    // Preferences (settings form)
    "settings.appLanguage": "App language",
    "settings.assistantLanguage": "Assistant language",
    "settings.defaultMode": "Default mode for new chats",
    "settings.memoryBehavior": "Memory behavior",
    "settings.autoModel": "Auto model",
    "settings.section.general": "General",
    "settings.section.personality": "Personality",
    "settings.section.modes": "Modes",
    "settings.section.capabilities": "Capabilities",
    "settings.capabilitiesHint":
      "Tool choices apply in the backend. Terminal and browser are powerful tools; approvals still apply.",
    "settings.resetCapabilities": "Use mode defaults",
    "settings.savePreferences": "Save preferences",
    "settings.preferencesSaved": "Saved",
    "settings.language": "Language",
    "settings.address": "Address me as",
    "settings.name": "Name",
    "settings.customAddress": "Custom address",
    "settings.tone": "Tone",
    "settings.verbosity": "Verbosity",
    "settings.humorPref": "Humor",
    "settings.initiative": "Initiative",
    "settings.mode": "Default mode",

    // App & assistant languages
    "lang.auto": "Auto",
    "lang.en": "English",
    "lang.ar": "Arabic",
    "lang.mixed": "Mixed Arabic/English",
    "lang.autoAssistant": "Auto — match my message language",

    // Memory behavior
    "memoryBehavior.auto": "Auto",
    "memoryBehavior.ask": "Ask",
    "memoryBehavior.off": "Off",
    "memoryBehavior.autoDesc": "Jack saves useful context when appropriate.",
    "memoryBehavior.askDesc": "Jack asks before saving to memory.",
    "memoryBehavior.offDesc": "Memory writes are disabled.",

    // Address options
    "address.name": "Name",
    "address.master": "Master",
    "address.lord": "Lord",
    "address.sir": "Sir",
    "address.custom": "Custom",

    // Tone / verbosity / humor / initiative
    "tone.jarvis": "Jarvis",
    "tone.dark": "Dark",
    "tone.direct": "Direct",
    "verbosity.concise": "Concise",
    "verbosity.normal": "Normal",
    "verbosity.detailed": "Detailed",
    "humorPref.off": "Off",
    "humorPref.dry": "Dry",
    "humorPref.dark": "Dark",
    "initiative.reactive": "Reactive",
    "initiative.balanced": "Balanced",
    "initiative.proactive": "Proactive",

    // Modes (match preferences.mjs MODES)
    "mode.auto.label": "Auto",
    "mode.auto.description":
      "Jack determines the best workflow, tools and capabilities for each request.",
    "mode.hacker.label": "Hacker",
    "mode.hacker.description":
      "System analysis, networking, cybersecurity, reverse engineering, debugging and technical investigation.",
    "mode.developer.label": "Developer",
    "mode.developer.description":
      "Code, repositories, architecture, testing, Git, builds and debugging.",
    "mode.research.label": "Research",
    "mode.research.description":
      "Current web information, multiple sources, documentation, comparison and citations.",
    "mode.empathy.label": "Empathy",
    "mode.empathy.description":
      "Natural conversation, emotional context and minimal tool use unless needed.",
    "mode.secret_agent.label": "Secret Agent",
    "mode.secret_agent.description":
      "Research, planning, information gathering, organization and concise operational reporting.",

    // Capability packs
    "pack.web": "Web search",
    "pack.browser": "Browser",
    "pack.computer": "Computer",
    "pack.terminal": "Terminal",
    "pack.files": "Files",
    "pack.git": "Git",
    "pack.memory": "Memory",
    "pack.research": "Research",
    "pack.developer": "Developer tools",

    // Buttons & common
    "button.save": "Save",
    "button.cancel": "Cancel",
    "button.close": "Close",
    "button.delete": "Delete",
    "button.refresh": "Refresh",
    "button.allow": "Allow",
    "button.deny": "Deny",
  },

  ar: {
    "brand.tagline": "COFFEEJACK / LOCAL INTELLIGENCE",
    "nav.workspace": "مساحتك",
    "nav.chat": "المحادثة",
    "nav.memory": "الذاكرة",
    "nav.activity": "سجل التنفيذ",
    "nav.persona": "شخصية Jack",
    "nav.settings": "الإعدادات",
    "nav.newChat": "محادثة جديدة",
    "nav.newChatShortcut": "Ctrl K",
    "nav.history": "المحادثات الأخيرة",
    "sidebar.private.title": "على جهازك. لك وحدك.",
    "sidebar.private.detail": "الذاكرة والمحادثات تُحفظ محليًا",
    "sidebar.profile.workspace": "مساحة شخصية",

    "header.workspace": "JACK WORKSPACE",
    "header.themeToggle": "تبديل المظهر",
    "header.newChat": "محادثة جديدة",

    "page.chat": "المحادثة",
    "page.memory": "الذاكرة",
    "page.activity": "سجل التنفيذ",
    "page.settings": "الإعدادات",
    "page.persona": "شخصية Jack",

    "connection.connecting": "جارٍ الاتصال",
    "connection.local": "متصل محليًا",
    "connection.modelNotReady": "الموديل غير جاهز",
    "connection.disconnected": "غير متصل",
    "connection.gamingPriority": "ألعابك أولًا",
    "gaming.mode": "وضع الألعاب",
    "gaming.modeOn": "وضع الألعاب مفعّل",
    "gaming.notice":
      "وضع الألعاب مفعّل؛ مهام Jack متوقفة والموديلات تُفرّغ من الذاكرة.",

    "welcome.kicker": "LOCAL INTELLIGENCE. YOUR COMMAND.",
    "welcome.presence.here": "Jack هنا",
    "welcome.presence.working": "Jack يعمل على طلبك",
    "welcome.presence.gaming": "Jack على وضع الألعاب",
    "welcome.headline.line1": "فكّر أبعد.",
    "welcome.headline.line2": "خلّ التنفيذ عليّ.",
    "welcome.body.line1": "أنا Jack. أفحص، أبني، وأتحقق من النتيجة.",
    "welcome.body.line2": "عقلك الإضافي. على جهازك. وتحت سيطرتك.",
    "welcome.suggest.build.title": "خلّينا نبني شيء",
    "welcome.suggest.build.detail": "موقع، برنامج، أو فكرة جديدة",
    "welcome.suggest.search.title": "ابحث معي",
    "welcome.suggest.search.detail": "معلومات أوضح، من مصادرها",
    "welcome.suggest.mood.title": "غيّر جوّي",
    "welcome.suggest.mood.detail": "شوية خفة دم، وبداية أخف",

    "composer.placeholder": "اكتب لـ Jack...",
    "composer.ariaLabel": "رسالتك إلى Jack",
    "composer.send": "إرسال",
    "composer.stop": "إيقاف",
    "composer.attach": "إرفاق ملف",
    "composer.taskType": "نوع المهمة",
    "composer.jackMode": "نمط Jack",
    "composer.currentMode": "النمط الحالي",
    "composer.footnote": "محلي أولًا · الأدوات تحت سيطرتك · Enter للإرسال",
    "composer.thinking": "Jack يجهّز الرد…",
    "composer.status.thinking": "Jack يفكر…",
    "composer.status.working": "Jack يعمل · الخطوة {round}",
    "composer.status.done": "اكتمل الرد · على جهازك",
    "composer.jumpBottom": "↓ آخر رد",
    "composer.modelLocal": "محلي",
    "composer.modelFallback": "بديل محلي",

    "composer.mode.auto": "تلقائي",
    "composer.mode.general": "محادثة",
    "composer.mode.coding": "برمجة",
    "composer.mode.vision": "صور",

    "chat.copyCode": "نسخ الكود",
    "chat.copyReply": "نسخ الرد",
    "chat.copied": "تم النسخ ✓",
    "chat.copyFailed": "تعذّر النسخ",
    "chat.deleteChat": "حذف المحادثة",
    "chat.deleteConfirm": "حذف هذه المحادثة؟",
    "chat.stopFirst": "أوقف المهمة الحالية أولًا.",
    "chat.searchPlaceholder": "ابحث في محادثاتك…",
    "chat.searchAria": "البحث في المحادثات",
    "chat.historyEmpty": "بداية جديدة،\nوأفكار كثيرة تنتظر.",

    "tool.running": "يعمل",
    "tool.done": "اكتمل",
    "tool.error": "تعذر التنفيذ",
    "tool.screenshotAlt": "لقطة من الأداة",
    "approval.title": "Jack يحتاج موافقتك: {name}",
    "approval.allow": "تنفيذ هذه الخطوة",
    "approval.deny": "رفض",

    "notice.engineOffline":
      "محرك الذكاء المحلي غير متصل. شغّل CoffeeJack من ملف Start CoffeeJack.",
    "notice.modelMissing":
      "الموديل المحدد غير مثبت بعد. أكمل تنزيله أو اختر موديلًا متاحًا في الإعدادات.",
    "notice.uploadMaxSize": "الحد الأعلى للملف 20 MB.",
    "notice.uploadMaxCount": "الحد الأعلى 5 ملفات.",
    "notice.requestFailed": "تعذر تنفيذ الطلب",

    "memory.eyebrow": "A LITTLE CONTEXT GOES A LONG WAY",
    "memory.title": "أشياء تستاهل نتذكرها.",
    "memory.intro":
      "تفضيلاتك، قراراتك، والدروس التي تعلّمناها. تقدر تضيفها أو تحذفها في أي وقت.",
    "memory.placeholder": "مثلًا: أفضل الشرح بالعربي مع أمثلة عملية",
    "memory.save": "حفظ في الذاكرة",
    "memory.deleteAria": "حذف الذاكرة",
    "memory.empty": "الذاكرة تبدأ معك. أضف أول تفضيل أو ملاحظة.",
    "memory.preferences": "التفضيلات",
    "memory.lessons": "الدروس",
    "memory.aboutMe": "عني",
    "memory.environment": "البيئة",
    "memory.projects": "المشاريع",
    "memory.kind.preference": "تفضيل",
    "memory.kind.lesson": "درس",
    "memory.kind.note": "ملاحظة",

    "activity.eyebrow": "EVERY STEP, IN THE OPEN",
    "activity.title": "تعرف إيش صار، بالضبط.",
    "activity.intro": "كل أداة استخدمها Jack ونتيجتها، محفوظة هنا على جهازك.",
    "activity.refresh": "تحديث السجل ↻",
    "activity.empty": "ما فيه خطوات تنفيذ بعد. ستظهر الأدوات ونتائجها هنا.",

    "persona.eyebrow": "MEET THE MIND BEHIND THE MUG",
    "persona.title.line1": "شخصية ثابتة.",
    "persona.title.line2": "بطريقتك أنت.",
    "persona.intro": "ذكي، حاد، وعملي. مزح أسود لما يناسب، ونتائج بدون تمثيل.",
    "persona.tabsAria": "أنماط الشخصية",
    "persona.preset.playful": "☕ رفيق القهوة",
    "persona.preset.focused": "⌘ وقت التركيز",
    "persona.preset.calm": "◌ على رواق",
    "persona.speechStyle": "طريقة الكلام",
    "persona.replyLanguage": "لغة الرد",
    "persona.dialect": "العربية اللي تريحك",
    "persona.humor": "جرعة خفة الدم",
    "persona.detail": "طول الرد",
    "persona.save": "حفظ شخصية Jack",
    "persona.previewEyebrow": "A LITTLE TASTE",
    "persona.previewTitle": "كذا ممكن يرد عليك",
    "persona.previewNote": "مثال على النبرة، مو رد مولّد. يضبط أسلوبه حسب الموقف.",
    "persona.principle.sharp": "◈ حاد وصادق",
    "persona.principle.loyal": "◇ مخلص لعبدالرحمن",
    "persona.principle.verify": "◎ يتحقق قبل ما يجزم",
    "persona.savePrompt": "احفظ لتطبيق التغييرات على الردود القادمة.",
    "persona.saved": "انحفظت. هذا أسلوبي من الآن ✓",
    "persona.dialect.jeddah": "سعودي / جداوي طبيعي",
    "persona.dialect.standard": "فصحى واضحة",
    "persona.humor.playful": "ساخر — ذكي وغامق لما يناسب",
    "persona.humor.subtle": "لمسة جافة خفيفة",
    "persona.humor.off": "بدون مزح",
    "persona.detail.concise": "المختصر المفيد",
    "persona.detail.balanced": "على قد الموضوع",
    "persona.detail.thorough": "بالتفصيل والأمثلة",
    "persona.previewQuestion.en": "Jack, my code broke.",
    "persona.previewQuestion.ar.standard": "يا Jack، توقف الكود عن العمل.",
    "persona.previewQuestion.ar.jeddah": "يا Jack، الكود خرب.",
    "persona.shortcut.playful": "حاد، ساخر وقت اللزوم",
    "persona.shortcut.subtle": "هادي، وفيه حدّة خفيفة",
    "persona.shortcut.off": "مركّز على النتيجة",
    "persona.self.eyebrow": "GROUNDED IN WHAT ACTUALLY HAPPENED",
    "persona.self.title": "يعرف سياقه، ويحاسب خطواته.",
    "persona.self.state.ready": "جاهز",
    "persona.self.state.working": "يعمل على طلبك",
    "persona.self.state.gaming": "الأولوية للعبة",
    "persona.self.memories": "ذكرى محفوظة",
    "persona.self.conversations": "محادثة",
    "persona.self.tools": "خطوة أداة ناجحة",
    "persona.self.reflectionEmpty": "تظهر هنا نتيجة آخر طلب بعد تنفيذه.",
    "persona.self.reflection":
      "آخر طلب: {result} · {successfulTools} أداة نجحت · {failedTools} أخطاء أدوات · {durationSeconds} ثانية. هذه نتائج تنفيذ فعلية، وليست أفكارًا داخلية.",
    "persona.self.outcome.completed": "اكتمل الرد",
    "persona.self.outcome.cancelled": "توقّف بطلبك",
    "persona.self.outcome.error": "توقّف بسبب خطأ",
    "persona.self.outcome.stepLimit": "وصل إلى حد الخطوات",
    "persona.awareness.summary": "إيش يعني «يعرف نفسه» هنا؟",
    "persona.awareness.body":
      "له هوية وتعليمات ثابتة، وذاكرة قابلة للتعديل، وملخص مبني على نتائج أدواته. هذا وعي وظيفي بالسياق والحدود، وليس ادعاءً بوعي ذاتي أو مشاعر بشرية. لا يعمل من تلقاء نفسه بين طلباتك.",

    "settings.eyebrow": "MAKE YOURSELF AT HOME",
    "settings.title": "Jack، على طريقتك.",
    "settings.intro":
      "الموديلات والمساحة والذاكرة تعمل من جهازك. خدمات الإنترنت تُستخدم فقط عندما تطلب أدوات الويب.",
    "settings.formAria": "تفضيلات Jack",
    "settings.localMind": "العقل المحلي",
    "settings.primaryModel": "الموديل الأساسي",
    "settings.codingModel": "موديل البرمجة",
    "settings.visionModel": "موديل الصور",
    "settings.visionHint":
      "اختر موديلًا يدعم الرؤية لتحليل الصور والشاشة. قائمة الموديلات تأتي من Ollama.",
    "settings.sameAsPrimary": "نفس الموديل الأساسي",
    "settings.workspaceCard": "مساحة العمل",
    "settings.workspaceFolder": "المجلد الذي ينشئ Jack المشاريع داخله",
    "settings.instructions": "أسلوبك وتفضيلاتك",
    "settings.instructionsPlaceholder": "كيف تحب Jack يساعدك؟",
    "settings.toolsCard": "الأدوات والصلاحيات",
    "settings.autoApprove": "تنفيذ تلقائي للأدوات",
    "settings.autoApproveHint":
      "عند التفعيل، ينفذ Jack الكتابة والأوامر والتحكم بدون تأكيد لكل خطوة. أوامر النظام يمكنها الوصول خارج مجلد المشروع. يمكنك إيقاف المهمة في أي وقت.",
    "settings.gamingCard": "الأولوية لألعابك",
    "settings.autoGaming": "تشغيل وضع الألعاب تلقائيًا",
    "settings.gameProcesses": "أسماء ملفات الألعاب، مفصولة بفواصل",
    "settings.gamingHint":
      "يفحص الألعاب المحددة كل 15 ثانية، يوقف المهمة ويفرّغ الموديلات. عند إغلاق اللعبة يصبح Jack جاهزًا لطلبك التالي.",
    "settings.save": "حفظ الإعدادات",
    "settings.saved": "تم حفظ الإعدادات.",
    "settings.branding": "Branding / الهوية",
    "settings.brandingBody":
      "Replace approved assets in public/jack/avatar.png, icon.png, or logo.png. A J monogram appears until then.",
    "settings.voiceNote":
      "Voice is not installed. Startup remains controlled by your CoffeeJack launcher.",

    "settings.appLanguage": "لغة الواجهة",
    "settings.assistantLanguage": "لغة المساعد",
    "settings.defaultMode": "النمط الافتراضي للمحادثات الجديدة",
    "settings.memoryBehavior": "سلوك الذاكرة",
    "settings.autoModel": "موديل تلقائي",
    "settings.section.general": "عام",
    "settings.section.personality": "الشخصية",
    "settings.section.modes": "الأنماط",
    "settings.section.capabilities": "القدرات",
    "settings.capabilitiesHint":
      "اختيارات الأدوات تُطبّق في الخلفية. الطرفية والمتصفح أدوات قوية؛ الموافقات ما زالت مطلوبة.",
    "settings.resetCapabilities": "إعدادات النمط الافتراضية",
    "settings.savePreferences": "حفظ التفضيلات",
    "settings.preferencesSaved": "تم الحفظ",
    "settings.language": "اللغة",
    "settings.address": "اللقب",
    "settings.name": "الاسم",
    "settings.customAddress": "لقب مخصص",
    "settings.tone": "النبرة",
    "settings.verbosity": "التفصيل",
    "settings.humorPref": "المزاح",
    "settings.initiative": "المبادرة",
    "settings.mode": "النمط الافتراضي",

    "lang.auto": "تلقائي",
    "lang.en": "English",
    "lang.ar": "العربية",
    "lang.mixed": "عربي/إنجليزي مختلط",
    "lang.autoAssistant": "تلقائي — نفس لغة رسالتي",

    "memoryBehavior.auto": "تلقائي",
    "memoryBehavior.ask": "اسأل",
    "memoryBehavior.off": "إيقاف",
    "memoryBehavior.autoDesc": "Jack يحفظ السياق المفيد عندما يناسب.",
    "memoryBehavior.askDesc": "Jack يسألك قبل الحفظ في الذاكرة.",
    "memoryBehavior.offDesc": "كتابة الذاكرة معطّلة.",

    "address.name": "الاسم",
    "address.master": "Master",
    "address.lord": "Lord",
    "address.sir": "Sir",
    "address.custom": "مخصص",

    "tone.jarvis": "Jarvis",
    "tone.dark": "Dark",
    "tone.direct": "مباشر",
    "verbosity.concise": "مختصر",
    "verbosity.normal": "عادي",
    "verbosity.detailed": "مفصّل",
    "humorPref.off": "بدون",
    "humorPref.dry": "جاف",
    "humorPref.dark": "أسود",
    "initiative.reactive": "تفاعلي",
    "initiative.balanced": "متوازن",
    "initiative.proactive": "استباقي",

    "mode.auto.label": "تلقائي",
    "mode.auto.description":
      "Jack يحدد أفضل سير عمل وأدوات وقدرات لكل طلب.",
    "mode.hacker.label": "Hacker",
    "mode.hacker.description":
      "تحليل أنظمة، شبكات، أمن سيبراني، هندسة عكسية، تصحيح وتحقيق تقني.",
    "mode.developer.label": "Developer",
    "mode.developer.description":
      "كود، مستودعات، بنية، اختبار، Git، بناء وتصحيح.",
    "mode.research.label": "Research",
    "mode.research.description":
      "معلومات ويب حالية، مصادر متعددة، توثيق، مقارنة واستشهاد.",
    "mode.empathy.label": "Empathy",
    "mode.empathy.description":
      "محادثة طبيعية، سياق عاطفي وأقل استخدام للأدوات إلا عند الحاجة.",
    "mode.secret_agent.label": "Secret Agent",
    "mode.secret_agent.description":
      "بحث، تخطيط، جمع معلومات، تنظيم وتقارير عملية موجزة.",

    "pack.web": "بحث الويب",
    "pack.browser": "المتصفح",
    "pack.computer": "الحاسوب",
    "pack.terminal": "الطرفية",
    "pack.files": "الملفات",
    "pack.git": "Git",
    "pack.memory": "الذاكرة",
    "pack.research": "البحث",
    "pack.developer": "أدوات المطور",

    "button.save": "حفظ",
    "button.cancel": "إلغاء",
    "button.close": "إغلاق",
    "button.delete": "حذف",
    "button.refresh": "تحديث",
    "button.allow": "موافقة",
    "button.deny": "رفض",
  },
};

/** @param {'auto'|'en'|'ar'} appLanguage */
export function resolveAppLocale(appLanguage) {
  if (appLanguage === "ar") return { lang: "ar", dir: "rtl" };
  if (appLanguage === "en") return { lang: "en", dir: "ltr" };
  const nav =
    (typeof navigator !== "undefined" && navigator.language) || "en";
  if (/^ar/i.test(nav)) return { lang: "ar", dir: "rtl" };
  return { lang: "en", dir: "ltr" };
}

/**
 * @param {string} key
 * @param {'en'|'ar'} [locale]
 * @param {Record<string, string|number>} [vars]
 */
export function t(key, locale = "en", vars) {
  const dict = dictionaries[locale] ?? dictionaries.en;
  let text = dict[key];
  if (text === undefined && locale !== "en") text = dictionaries.en[key];
  if (text === undefined) return key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** @param {{ lang: 'en'|'ar', dir: 'ltr'|'rtl' }} locale */
export function applyDocumentLocale(locale) {
  const root = document.documentElement;
  root.lang = locale.lang;
  root.dir = locale.dir;
}

/**
 * Apply data-i18n* attributes under root.
 * @param {ParentNode} [root]
 * @param {'en'|'ar'} [locale]
 */
export function applyStaticI18n(root = document, locale) {
  const lang =
    locale ??
    (document.documentElement.lang === "ar" ? "ar" : "en");

  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key, lang);
  });

  for (const attr of ["placeholder", "aria", "title"]) {
    root.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
      const key = el.getAttribute(`data-i18n-${attr}`);
      if (!key) return;
      const value = t(key, lang);
      if (attr === "aria") el.setAttribute("aria-label", value);
      else el.setAttribute(attr, value);
    });
  }
}
