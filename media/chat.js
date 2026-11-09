// @ts-check
/* DeepSeek Agent chat webview. Runs sandboxed: all model access happens in the extension host. */
(function () {
	const vscode = acquireVsCodeApi();

	const els = {
		messages: document.getElementById('messages'),
		emptyState: document.getElementById('empty-state'),
		input: document.getElementById('input'),
		composerBox: document.getElementById('composer-box'),
		send: document.getElementById('btn-send'),
		sendLabel: document.getElementById('send-label'),
		hint: document.getElementById('hint'),
		modelChip: document.getElementById('model-chip'),
		modelLabel: document.getElementById('model-label'),
		newChat: document.getElementById('btn-new-chat'),
		settingsButton: document.getElementById('btn-settings'),
		settings: document.getElementById('settings'),
		closeSettings: document.getElementById('btn-close-settings'),
		keyInput: document.getElementById('input-key'),
		keyStatus: document.getElementById('key-status'),
		modelInput: document.getElementById('input-model'),
		baseUrlInput: document.getElementById('input-base-url'),
		saveSettings: document.getElementById('btn-save-settings'),
		clearKey: document.getElementById('btn-clear-key'),
		getKey: document.getElementById('btn-get-key'),
		toast: document.getElementById('toast'),
	};

	const state = {
		config: {
			hasApiKey: false,
			keyHint: '',
			model: 'deepseek-chat',
			baseUrl: 'https://api.deepseek.com',
			models: ['deepseek-chat', 'deepseek-reasoner'],
			busy: false,
		},
		busy: false,
		counter: 0,
		pending: /** @type {{requestId: string, text: string} | null} */ (null),
		stream: /** @type {null | {content: string, reasoning: string, contentEl: HTMLElement, reasoningBox: HTMLElement, reasoningBody: HTMLElement, typing: HTMLElement, timer: number}} */ (null),
		toastTimer: 0,
	};

	// ------------------------------------------------------------ bootstrap

	const iconUri = document.body.dataset.icon || '';
	const logo = els.emptyState.querySelector('.empty-logo');
	if (logo && iconUri) {
		logo.src = iconUri;
	}

	document.querySelectorAll('.suggestion').forEach((button) => {
		button.addEventListener('click', () => {
			els.input.value = button.dataset.prompt || '';
			autoGrow();
			els.input.focus();
		});
	});

	vscode.postMessage({ type: 'ready' });

	// ---------------------------------------------------------------- events

	els.send.addEventListener('click', () => (state.busy ? stopStreaming() : submit()));
	els.newChat.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
	els.settingsButton.addEventListener('click', () => openSettings());
	els.modelChip.addEventListener('click', () => openSettings({ focus: 'model' }));
	els.closeSettings.addEventListener('click', () => closeSettings());
	els.saveSettings.addEventListener('click', () => saveSettings());
	els.clearKey.addEventListener('click', () => vscode.postMessage({ type: 'clearApiKey' }));
	els.getKey.addEventListener('click', () =>
		vscode.postMessage({ type: 'openExternal', url: 'https://platform.deepseek.com/api_keys' }),
	);

	els.input.addEventListener('input', autoGrow);
	els.input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			if (!state.busy) {
				submit();
			}
		}
	});

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && !els.settings.hidden) {
			closeSettings();
		}
	});

	// Copy buttons and external links inside rendered messages.
	els.messages.addEventListener('click', (event) => {
		const target = /** @type {HTMLElement} */ (event.target);

		const copyButton = target.closest('.copy');
		if (copyButton) {
			const block = copyButton.closest('.code-block');
			const code = block ? block.querySelector('code') : null;
			if (code) {
				void navigator.clipboard.writeText(code.textContent || '');
				copyButton.textContent = 'Copied';
				setTimeout(() => {
					copyButton.textContent = 'Copy';
				}, 1200);
			}
			return;
		}

		const settingsAction = target.closest('[data-action="settings"]');
		if (settingsAction) {
			openSettings();
			return;
		}

		const link = target.closest('a[href]');
		if (link) {
			event.preventDefault();
			const href = link.getAttribute('href') || '';
			if (/^https:\/\//i.test(href)) {
				vscode.postMessage({ type: 'openExternal', url: href });
			}
			return;
		}

		const suggestion = target.closest('.suggestion');
		if (suggestion) {
			els.input.value = suggestion.dataset.prompt || '';
			autoGrow();
			els.input.focus();
		}
	});

	window.addEventListener('message', (event) => handleMessage(event.data));

	// -------------------------------------------------------- host messages

	function handleMessage(message) {
		switch (message.type) {
			case 'init':
				applyConfig(message.config);
				renderTranscript(message.transcript || []);
				break;
			case 'config':
				applyConfig(message.config);
				break;
			case 'transcript':
				renderTranscript(message.transcript || []);
				break;
			case 'accepted':
				state.pending = null;
				setBusy(true);
				startAssistantMessage();
				break;
			case 'append':
				appendEntry(message.entry);
				break;
			case 'delta':
				updateStream(message.content, message.reasoning);
				break;
			case 'done':
				finishStream();
				break;
			case 'error':
				handleError(message);
				break;
			case 'notice':
				showToast(message.message);
				break;
			case 'openSettings':
				openSettings();
				break;
		}
	}

	function applyConfig(config) {
		state.config = config;
		state.busy = Boolean(config.busy);
		els.modelLabel.textContent = config.model || 'deepseek-chat';
		els.modelChip.classList.toggle('ready', Boolean(config.hasApiKey));
		els.modelChip.title = config.hasApiKey ? 'DeepSeek key configured - change model' : 'No API key yet - open settings';

		els.keyStatus.textContent = config.hasApiKey
			? `A key is saved (${config.keyHint}). Enter a new one to replace it.`
			: 'No key saved yet.';
		els.keyStatus.classList.toggle('ok', Boolean(config.hasApiKey));

		populateModels(config.models || [], config.model);
		if (document.activeElement !== els.baseUrlInput || els.baseUrlInput.value === '') {
			els.baseUrlInput.value = config.baseUrl || '';
		}
		if (config.hasApiKey && !els.keyInput.value) {
			els.keyInput.placeholder = config.keyHint || 'sk-...';
		}

		setBusy(state.busy && Boolean(state.stream));
		if (state.busy && !state.stream) {
			// Webview was reloaded mid-stream: show that work is in flight.
			startAssistantMessage();
		}
		if (!state.busy) {
			els.sendLabel.textContent = 'Send';
			els.send.classList.remove('stop');
		}
	}

	function populateModels(models, selected) {
		const list = models.length > 0 ? models : ['deepseek-chat', 'deepseek-reasoner'];
		const current = selected || list[0];
		const existing = Array.from(els.modelInput.options).map((option) => option.value);
		if (existing.length !== list.length || existing.some((value, index) => value !== list[index])) {
			els.modelInput.innerHTML = '';
			for (const model of list) {
				const option = document.createElement('option');
				option.value = model;
				option.textContent = model;
				els.modelInput.appendChild(option);
			}
		}
		els.modelInput.value = current;
	}

	// ------------------------------------------------------------ transcript

	function renderTranscript(transcript) {
		finishStream(true);
		els.messages.querySelectorAll('.msg, .error-card').forEach((node) => node.remove());
		els.emptyState.hidden = transcript.length > 0;
		for (const entry of transcript) {
			appendEntry(entry);
		}
		scrollToBottom(true);
	}

	function appendEntry(entry) {
		els.emptyState.hidden = true;

		if (entry.role === 'user') {
			const wrapper = document.createElement('div');
			wrapper.className = 'msg msg-user';
			const bubble = document.createElement('div');
			bubble.className = 'bubble';
			bubble.textContent = entry.content;
			wrapper.appendChild(bubble);
			els.messages.appendChild(wrapper);
		} else {
			const content = document.createElement('div');
			content.className = 'markdown';
			content.innerHTML = renderMarkdown(entry.content || '');
			els.messages.appendChild(buildAssistant(entry.reasoning || '', content));
		}

		if (entry.error) {
			els.messages.appendChild(buildError(entry.error, false));
		}

		scrollToBottom();
	}

	function buildAssistant(reasoning, contentEl) {
		const wrapper = document.createElement('div');
		wrapper.className = 'msg msg-assistant';

		const body = document.createElement('div');
		body.className = 'body';

		if (reasoning.trim().length > 0) {
			const details = document.createElement('details');
			details.className = 'reasoning';
			const summary = document.createElement('summary');
			summary.textContent = 'Reasoning';
			const reasoningBody = document.createElement('div');
			reasoningBody.className = 'reasoning-body';
			reasoningBody.textContent = reasoning;
			details.append(summary, reasoningBody);
			body.appendChild(details);
		}

		body.appendChild(contentEl);
		wrapper.appendChild(body);
		return wrapper;
	}

	function buildError(message, needsApiKey) {
		const card = document.createElement('div');
		card.className = 'error-card';
		card.textContent = message;
		if (needsApiKey) {
			const action = document.createElement('button');
			action.type = 'button';
			action.className = 'error-action';
			action.dataset.action = 'settings';
			action.textContent = 'Open settings to add your API key';
			card.appendChild(document.createElement('br'));
			card.appendChild(action);
		}
		return card;
	}

	// -------------------------------------------------------------- streaming

	function startAssistantMessage() {
		finishStream(true);
		els.emptyState.hidden = true;

		const contentEl = document.createElement('div');
		contentEl.className = 'markdown';

		const wrapper = buildAssistant('', contentEl);
		const typing = document.createElement('div');
		typing.className = 'typing';
		typing.innerHTML = '<span></span><span></span><span></span>';
		contentEl.appendChild(typing);

		els.messages.appendChild(wrapper);

		state.stream = {
			content: '',
			reasoning: '',
			contentEl,
			reasoningBox: wrapper.querySelector('.reasoning'),
			reasoningBody: wrapper.querySelector('.reasoning-body'),
			typing,
			timer: 0,
		};

		setBusy(true);
		scrollToBottom(true);
	}

	function updateStream(content, reasoning) {
		if (!state.stream) {
			startAssistantMessage();
		}
		const stream = state.stream;
		if (!stream) {
			return;
		}

		stream.content = content || '';
		stream.reasoning = reasoning || '';

		if (stream.reasoning.trim().length > 0) {
			if (!stream.reasoningBox) {
				// Reasoning arrived late: rebuild the container so the block shows up.
				const details = document.createElement('details');
				details.className = 'reasoning';
				const summary = document.createElement('summary');
				summary.textContent = 'Reasoning';
				const body = document.createElement('div');
				body.className = 'reasoning-body';
				details.append(summary, body);
				const bodyContainer = stream.contentEl.parentElement;
				if (bodyContainer) {
					bodyContainer.insertBefore(details, stream.contentEl);
				}
				stream.reasoningBox = details;
				stream.reasoningBody = body;
			}
			if (stream.reasoningBody) {
				stream.reasoningBody.textContent = stream.reasoning;
			}
		}

		if (stream.timer === 0) {
			stream.timer = window.setTimeout(() => {
				if (state.stream) {
					state.stream.timer = 0;
					paintStream();
				}
			}, 80);
		}
	}

	function paintStream() {
		const stream = state.stream;
		if (!stream) {
			return;
		}

		const atBottom = isNearBottom();
		if (stream.typing && stream.typing.parentElement) {
			stream.typing.remove();
		}
		if (stream.content.trim().length > 0) {
			stream.contentEl.innerHTML = renderMarkdown(stream.content);
		}
		if (atBottom) {
			scrollToBottom();
		}
	}

	function finishStream(silent) {
		const stream = state.stream;
		if (!stream) {
			return;
		}
		if (stream.timer) {
			clearTimeout(stream.timer);
		}
		state.stream = null;

		if (stream.typing && stream.typing.parentElement) {
			stream.typing.remove();
		}
		stream.contentEl.innerHTML = renderMarkdown(stream.content);

		if (!silent) {
			setBusy(false);
			scrollToBottom();
			els.input.focus();
		}
	}

	function stopStreaming() {
		vscode.postMessage({ type: 'stop' });
		els.send.disabled = true;
		els.sendLabel.textContent = 'Stopping';
	}

	// ----------------------------------------------------------------- errors

	function handleError(message) {
		const wasPending = state.pending && state.pending.requestId === message.requestId;
		if (wasPending && state.pending) {
			// The message was never accepted: put it back in the composer.
			els.input.value = state.pending.text;
			autoGrow();
			state.pending = null;
			finishStream(true);
			setBusy(false);
		} else {
			finishStream(true);
			setBusy(false);
		}

		if (state.stream) {
			state.stream = null;
		}
		els.messages.appendChild(buildError(message.message, Boolean(message.needsApiKey)));
		scrollToBottom(true);

		if (message.needsApiKey) {
			openSettings();
		}
	}

	// ---------------------------------------------------------------- sending

	function submit() {
		const text = els.input.value.trim();
		if (text.length === 0 || state.busy) {
			return;
		}

		state.counter += 1;
		const requestId = `req-${state.counter}-${Date.now()}`;
		state.pending = { requestId, text };

		els.input.value = '';
		autoGrow();
		setBusy(true);
		vscode.postMessage({ type: 'send', requestId, text });
	}

	function setBusy(busy) {
		state.busy = busy;
		els.send.disabled = false;
		els.send.classList.toggle('stop', busy);
		els.sendLabel.textContent = busy ? 'Stop' : 'Send';
		els.send.title = busy ? 'Stop generating' : 'Send';
		els.hint.textContent = busy ? 'Generating response...' : 'Enter to send \u00b7 Shift+Enter for a new line';
	}

	// --------------------------------------------------------------- settings

	function openSettings(options) {
		els.settings.hidden = false;
		els.keyInput.value = '';
		if (options && options.focus === 'model') {
			els.modelInput.focus();
		} else {
			els.keyInput.focus();
		}
		els.settings.querySelector('.settings-inner').scrollTop = 0;
	}

	function closeSettings() {
		els.settings.hidden = true;
		els.input.focus();
	}

	function saveSettings() {
		const apiKey = els.keyInput.value.trim();
		const model = els.modelInput.value || 'deepseek-chat';
		const baseUrl = els.baseUrlInput.value.trim() || 'https://api.deepseek.com';

		if (!/^https?:\/\/.+/i.test(baseUrl)) {
			showToast('Base URL must start with http:// or https://');
			return;
		}

		els.saveSettings.disabled = true;
		els.saveSettings.textContent = 'Saving...';
		vscode.postMessage({
			type: 'saveSettings',
			apiKey: apiKey.length > 0 ? apiKey : undefined,
			model,
			baseUrl,
		});
		setTimeout(() => {
			els.saveSettings.disabled = false;
			els.saveSettings.textContent = 'Save';
		}, 600);
		els.keyInput.value = '';
		closeSettings();
	}

	// ------------------------------------------------------------------ toast

	function showToast(message) {
		els.toast.textContent = message;
		els.toast.hidden = false;
		if (state.toastTimer) {
			clearTimeout(state.toastTimer);
		}
		state.toastTimer = window.setTimeout(() => {
			els.toast.hidden = true;
			state.toastTimer = 0;
		}, 5000);
	}

	// ------------------------------------------------------------- utilities

	function autoGrow() {
		els.input.style.height = 'auto';
		els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
	}

	function isNearBottom() {
		return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
	}

	function scrollToBottom(force) {
		if (force || isNearBottom()) {
			els.messages.scrollTop = els.messages.scrollHeight;
		}
	}

	// -------------------------------------------------------------- markdown

	function escapeHtml(text) {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function renderInline(text) {
		return text
			.replace(/`([^`\n]+)`/g, (_match, code) => `<code>${code}</code>`)
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
			.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
			.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
			.replace(
				/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
				'<a href="$2" rel="noreferrer noopener">$1</a>',
			);
	}

	function codeBlock(code, language) {
		const lang = (language || 'text').toLowerCase();
		return (
			'<div class="code-block">' +
			'<div class="code-head">' +
			`<span class="lang">${escapeHtml(lang)}</span>` +
			'<button class="copy" type="button">Copy</button>' +
			'</div>' +
			`<pre><code>${escapeHtml(code)}</code></pre>` +
			'</div>'
		);
	}

	function renderMarkdown(source) {
		const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
		const out = [];
		let index = 0;
		let listType = null;

		const closeList = () => {
			if (listType) {
				out.push(`</${listType}>`);
				listType = null;
			}
		};

		while (index < lines.length) {
			const line = lines[index];

			const fence = line.match(/^\s*```+\s*([\w+#.-]*)\s*$/);
			if (fence) {
				closeList();
				const code = [];
				index += 1;
				while (index < lines.length && !/^\s*```+\s*$/.test(lines[index])) {
					code.push(lines[index]);
					index += 1;
				}
				index += 1; // closing fence (may be absent while streaming)
				out.push(codeBlock(code.join('\n'), fence[1]));
				continue;
			}

			if (/^\s*$/.test(line)) {
				closeList();
				index += 1;
				continue;
			}

			const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
			if (heading) {
				closeList();
				const level = heading[1].length;
				out.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
				index += 1;
				continue;
			}

			if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
				closeList();
				out.push('<hr />');
				index += 1;
				continue;
			}

			if (/^\s{0,3}>/.test(line)) {
				closeList();
				const quoted = [];
				while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
					quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
					index += 1;
				}
				out.push(`<blockquote>${renderInline(escapeHtml(quoted.join(' ')))}</blockquote>`);
				continue;
			}

			const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
			const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
			if (bullet || numbered) {
				const type = bullet ? 'ul' : 'ol';
				if (listType !== type) {
					closeList();
					out.push(`<${type}>`);
					listType = type;
				}
				const item = (bullet || numbered)[1];
				out.push(`<li>${renderInline(escapeHtml(item))}</li>`);
				index += 1;
				continue;
			}

			closeList();
			const paragraph = [line];
			index += 1;
			while (
				index < lines.length &&
				lines[index].trim().length > 0 &&
				!/^\s*```/.test(lines[index]) &&
				!/^\s{0,3}#{1,6}\s/.test(lines[index]) &&
				!/^\s{0,3}>/.test(lines[index]) &&
				!/^\s*[-*+]\s/.test(lines[index]) &&
				!/^\s*\d+[.)]\s/.test(lines[index])
			) {
				paragraph.push(lines[index]);
				index += 1;
			}
			out.push(`<p>${renderInline(escapeHtml(paragraph.join('\n'))).replace(/\n/g, '<br />')}</p>`);
		}

		closeList();
		return out.join('');
	}

	// Keep the composer height correct on first paint.
	autoGrow();
})();
