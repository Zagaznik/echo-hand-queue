const ECHO_HQ_MODULE_ID = "echo-hand-queue";
const ECHO_HQ_SOCKET = `module.${ECHO_HQ_MODULE_ID}`;

class EchoHandQueueApp extends Application {
  static get defaultOptions() {
    const merge = foundry?.utils?.mergeObject ?? mergeObject;
    return merge(super.defaultOptions, {
      id: "echo-hand-queue-app",
      title: "Заявки игроков",
      template: `modules/${ECHO_HQ_MODULE_ID}/templates/queue.hbs`,
      width: 360,
      height: "auto",
      resizable: true,
      classes: ["echo-hand-queue-window"]
    });
  }

  getData() {
    return {
      requests: EchoHandQueue.queue.map((request) => ({
        ...request,
        statusLabel: EchoHandQueue.statusLabel(request.status)
      }))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find(".echo-hq-clear").on("click", async (event) => {
      event.preventDefault();
      const userId = event.currentTarget?.dataset?.userId;
      if (!userId) return;
      await EchoHandQueue.gmRemoveRequest(userId, { broadcast: true });
    });
  }
}

const EchoHandQueue = {
  queue: [],
  app: null,
  lastControlClickAt: 0,

  STATUSES: {
    low: {
      id: "low",
      label: "Не срочная заявка",
      icon: "fa-regular fa-hand",
      chatClass: "echo-hq-chat-low"
    },
    urgent: {
      id: "urgent",
      label: "Срочная заявка",
      icon: "fa-solid fa-hand",
      chatClass: "echo-hq-chat-urgent"
    },
    now: {
      id: "now",
      label: "Вмешаться прямо сейчас",
      icon: "fa-solid fa-hand-fist",
      chatClass: "echo-hq-chat-now"
    }
  },

  registerSettings() {
    game.settings.register(ECHO_HQ_MODULE_ID, "queue", {
      name: "Текущая очередь заявок",
      scope: "world",
      config: false,
      type: Object,
      default: { requests: [] }
    });

    game.settings.register(ECHO_HQ_MODULE_ID, "soundEnabled", {
      name: "Звук заявки",
      hint: "Проигрывать короткий звук у игрока, отправившего заявку, и у Мастера.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(ECHO_HQ_MODULE_ID, "soundPath", {
      name: "Файл звука заявки",
      hint: "Путь к аудиофайлу. По умолчанию используется звук из модуля.",
      scope: "world",
      config: true,
      type: String,
      default: `modules/${ECHO_HQ_MODULE_ID}/sounds/request.wav`
    });

    game.settings.register(ECHO_HQ_MODULE_ID, "soundVolume", {
      name: "Громкость звука заявки",
      hint: "Число от 0 до 1.",
      scope: "world",
      config: true,
      type: Number,
      range: {
        min: 0,
        max: 1,
        step: 0.05
      },
      default: 0.65
    });
  },

  statusLabel(status) {
    return this.STATUSES[status]?.label ?? "Заявка";
  },

  getStatus(status) {
    return this.STATUSES[status] ?? this.STATUSES.low;
  },

  addControlButton(controls) {
    const handler = () => this.openRequestDialogFromControl();
    const tool = {
      name: "echoHandQueue",
      title: "Заявка Мастеру",
      icon: "fa-solid fa-hand",
      button: true,
      visible: true,
      onClick: handler,
      onChange: handler
    };

    if (Array.isArray(controls)) {
      const tokenControl = controls.find((control) => control.name === "token" || control.name === "tokens");
      if (tokenControl) {
        tokenControl.tools ??= [];
        if (!tokenControl.tools.some((existing) => existing.name === tool.name)) tokenControl.tools.push(tool);
      } else {
        controls.push({
          name: "echoHandQueue",
          title: "Заявка Мастеру",
          icon: "fa-solid fa-hand",
          layer: "TokenLayer",
          tools: [tool],
          activeTool: "echoHandQueue"
        });
      }
      return;
    }

    const tokenControl = controls.tokens
      ?? controls.token
      ?? Object.values(controls).find((control) => control?.name === "tokens" || control?.name === "token");

    if (tokenControl) {
      if (Array.isArray(tokenControl.tools)) {
        if (!tokenControl.tools.some((existing) => existing.name === tool.name)) tokenControl.tools.push(tool);
      } else {
        tokenControl.tools ??= {};
        tokenControl.tools.echoHandQueue = {
          ...tool,
          order: Object.keys(tokenControl.tools).length + 100
        };
      }
      return;
    }

    controls.echoHandQueue = {
      name: "echoHandQueue",
      title: "Заявка Мастеру",
      icon: "fa-solid fa-hand",
      layer: "tokens",
      tools: {
        echoHandQueue: tool
      },
      activeTool: "echoHandQueue"
    };
  },

  openRequestDialogFromControl() {
    const now = Date.now();
    if (now - this.lastControlClickAt < 250) return;
    this.lastControlClickAt = now;
    this.openRequestDialog();
  },

  openRequestDialog() {
    const existing = this.queue.find((request) => request.userId === game.user.id);
    const content = `
      <p class="echo-hq-choice-note">
        ${existing
          ? `У тебя уже есть заявка: <strong>${this.escapeHtml(this.statusLabel(existing.status))}</strong>. Можно обновить её статус.`
          : "Выбери, насколько сильно нужно внимание Мастера."
        }
      </p>
    `;

    new Dialog({
      title: "Заявка Мастеру",
      content,
      buttons: {
        low: {
          icon: `<i class="${this.STATUSES.low.icon}"></i>`,
          label: this.STATUSES.low.label,
          callback: () => this.submitRequest("low")
        },
        urgent: {
          icon: `<i class="${this.STATUSES.urgent.icon}"></i>`,
          label: this.STATUSES.urgent.label,
          callback: () => this.submitRequest("urgent")
        },
        now: {
          icon: `<i class="${this.STATUSES.now.icon}"></i>`,
          label: this.STATUSES.now.label,
          callback: () => this.submitRequest("now")
        }
      },
      default: "low"
    }).render(true);
  },

  async submitRequest(status) {
    const activeGM = game.users?.some((user) => user.active && user.isGM);
    if (!game.user.isGM && !activeGM) {
      ui.notifications.warn("Сейчас нет активного Мастера, заявка не отправлена.");
      return;
    }

    const context = this.getCurrentCharacterContext();
    const request = {
      userId: game.user.id,
      userName: game.user.name,
      status,
      actorId: context.actorId,
      actorName: context.actorName,
      img: context.img,
      sceneId: context.sceneId,
      tokenId: context.tokenId,
      tokenName: context.tokenName,
      submittedAt: Date.now()
    };

    this.playRequestSound();
    await this.createPublicChatMessage(request, context.speaker);

    if (game.user.isGM) {
      await this.gmUpsertRequest(request, { playSound: false, notify: false, broadcast: true });
      return;
    }

    game.socket.emit(ECHO_HQ_SOCKET, {
      action: "request",
      request
    });
  },

  getCurrentCharacterContext() {
    const controlledToken = canvas?.tokens?.controlled?.[0] ?? null;
    const actor = controlledToken?.actor ?? game.user.character ?? null;
    const tokenDocument = controlledToken?.document ?? null;

    const actorName = actor?.name
      ?? tokenDocument?.name
      ?? game.user.name
      ?? "Игрок";

    const img = tokenDocument?.texture?.src
      ?? actor?.img
      ?? game.user.avatar
      ?? "icons/svg/mystery-man.svg";

    const speaker = actor
      ? ChatMessage.getSpeaker({ actor, token: tokenDocument })
      : ChatMessage.getSpeaker();

    return {
      actor,
      actorId: actor?.id ?? null,
      actorName,
      img,
      sceneId: canvas?.scene?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      tokenName: tokenDocument?.name ?? null,
      speaker
    };
  },

  async createPublicChatMessage(request, speaker) {
    const status = this.getStatus(request.status);
    const actorName = this.escapeHtml(request.actorName);
    const statusLabel = this.escapeHtml(status.label);
    const userName = this.escapeHtml(request.userName);

    const content = `
      <div class="echo-hq-chat ${status.chatClass}">
        <strong>✋ ${actorName}</strong> отправляет заявку Мастеру:
        <span class="echo-hq-chat-status">${statusLabel}</span>.
        <br><small>Игрок: ${userName}</small>
      </div>
    `;

    await ChatMessage.create({
      speaker,
      content
    });
  },

  async onSocketMessage(packet) {
    if (!game.user.isGM) return;
    if (!packet || typeof packet !== "object") return;

    if (packet.action === "request") {
      await this.gmUpsertRequest(packet.request, { playSound: true, notify: true, broadcast: true });
      return;
    }

    if (packet.action === "remove") {
      if (packet.gmId === game.user.id) return;
      await this.gmRemoveRequest(packet.userId, { broadcast: false });
      return;
    }

    if (packet.action === "state") {
      if (packet.gmId === game.user.id) return;
      this.queue = this.normalizeQueue(packet.queue ?? []);
      this.renderGMWindow();
    }
  },

  async gmUpsertRequest(rawRequest, { playSound = true, notify = true, broadcast = true } = {}) {
    if (!game.user.isGM || !rawRequest?.userId) return;

    const request = this.sanitizeRequest(rawRequest);
    const existingIndex = this.queue.findIndex((queued) => queued.userId === request.userId);

    if (existingIndex >= 0) {
      const previous = this.queue[existingIndex];
      this.queue[existingIndex] = {
        ...previous,
        ...request,
        createdAt: previous.createdAt ?? request.submittedAt ?? Date.now(),
        updatedAt: Date.now()
      };
    } else {
      this.queue.push({
        ...request,
        createdAt: request.submittedAt ?? Date.now(),
        updatedAt: Date.now()
      });
    }

    this.queue.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    await this.saveQueue();
    this.renderGMWindow();

    if (playSound) this.playRequestSound();
    if (notify) ui.notifications.info(`Заявка Мастеру: ${request.actorName} — ${this.statusLabel(request.status)}`);
    if (broadcast) this.broadcastState();
  },

  async gmRemoveRequest(userId, { broadcast = true } = {}) {
    if (!game.user.isGM || !userId) return;

    const before = this.queue.length;
    this.queue = this.queue.filter((request) => request.userId !== userId);
    if (this.queue.length === before) return;

    await this.saveQueue();
    this.renderGMWindow();

    if (broadcast) {
      game.socket.emit(ECHO_HQ_SOCKET, {
        action: "remove",
        userId,
        gmId: game.user.id
      });
      this.broadcastState();
    }
  },

  sanitizeRequest(request) {
    const status = this.STATUSES[request.status] ? request.status : "low";
    return {
      userId: String(request.userId),
      userName: String(request.userName ?? "Игрок"),
      status,
      actorId: request.actorId ? String(request.actorId) : null,
      actorName: String(request.actorName ?? request.tokenName ?? request.userName ?? "Игрок"),
      img: String(request.img ?? "icons/svg/mystery-man.svg"),
      sceneId: request.sceneId ? String(request.sceneId) : null,
      tokenId: request.tokenId ? String(request.tokenId) : null,
      tokenName: request.tokenName ? String(request.tokenName) : null,
      submittedAt: Number(request.submittedAt ?? Date.now())
    };
  },

  normalizeQueue(rawQueue) {
    const queue = Array.isArray(rawQueue) ? rawQueue : [];
    return queue
      .filter((request) => request?.userId)
      .map((request) => ({
        ...this.sanitizeRequest(request),
        createdAt: Number(request.createdAt ?? request.submittedAt ?? Date.now()),
        updatedAt: Number(request.updatedAt ?? request.submittedAt ?? Date.now())
      }))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  },

  loadQueueFromSettings() {
    if (!game.user.isGM) return;
    const stored = game.settings.get(ECHO_HQ_MODULE_ID, "queue");
    this.queue = this.normalizeQueue(stored?.requests ?? []);
    this.renderGMWindow();
  },

  async saveQueue() {
    if (!game.user.isGM) return;
    await game.settings.set(ECHO_HQ_MODULE_ID, "queue", { requests: this.queue });
  },

  broadcastState() {
    if (!game.user.isGM) return;
    game.socket.emit(ECHO_HQ_SOCKET, {
      action: "state",
      gmId: game.user.id,
      queue: this.queue
    });
  },

  renderGMWindow() {
    if (!game.user.isGM) return;

    if (!this.queue.length) {
      if (this.app?.rendered) this.app.close();
      this.app = null;
      return;
    }

    if (!this.app) this.app = new EchoHandQueueApp();
    this.app.render(true);
  },

  playRequestSound() {
    if (!game.settings.get(ECHO_HQ_MODULE_ID, "soundEnabled")) return;

    const src = game.settings.get(ECHO_HQ_MODULE_ID, "soundPath") || `modules/${ECHO_HQ_MODULE_ID}/sounds/request.wav`;
    const volumeSetting = Number(game.settings.get(ECHO_HQ_MODULE_ID, "soundVolume"));
    const volume = Number.isFinite(volumeSetting) ? Math.min(Math.max(volumeSetting, 0), 1) : 0.65;

    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch (error) {
      console.warn(`${ECHO_HQ_MODULE_ID} | Не удалось проиграть звук заявки`, error);
    }
  },

  escapeHtml(value) {
    if (foundry?.utils?.escapeHTML) return foundry.utils.escapeHTML(String(value ?? ""));
    const div = document.createElement("div");
    div.innerText = String(value ?? "");
    return div.innerHTML;
  }
};

Hooks.once("init", () => {
  EchoHandQueue.registerSettings();
  globalThis.EchoHandQueue = EchoHandQueue;
});

Hooks.once("ready", () => {
  game.socket.on(ECHO_HQ_SOCKET, (packet) => EchoHandQueue.onSocketMessage(packet));
  if (game.user.isGM) EchoHandQueue.loadQueueFromSettings();
  console.log(`${ECHO_HQ_MODULE_ID} | Готово`);
});

Hooks.on("getSceneControlButtons", (controls) => {
  EchoHandQueue.addControlButton(controls);
});
