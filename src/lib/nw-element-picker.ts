export const NW_PICKER_SELECTED_MARKER = '[cells-nw-picker-selected]'
export const NW_PICKER_CANCELLED_MARKER = '[cells-nw-picker-cancelled]'

export function buildElementPickerScript(targetAgentWindowId: string | null) {
  return `
      (() => {
        const selectedMarker = ${JSON.stringify(NW_PICKER_SELECTED_MARKER)};
        const cancelledMarker = ${JSON.stringify(NW_PICKER_CANCELLED_MARKER)};
        const targetAgentWindowId = ${JSON.stringify(targetAgentWindowId)};
        if (window.__cellsNwElementPickerCancel) window.__cellsNwElementPickerCancel(false);
        const state = { hovered: null, previousCursor: document.documentElement.style.cursor, previousUserSelect: document.documentElement.style.userSelect };
        const truncate = (value, limit) => {
          const text = String(value || '');
          return text.length > limit ? text.slice(0, limit) + '...' : text;
        };
        const normalize = (value, limit) => truncate(String(value || '').replace(/\\s+/g, ' ').trim(), limit);
        const cssEscape = (value) => window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => '\\\\' + char);
        const attrEscape = (value) => String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
        const matches = (selector, element) => {
          try { return document.querySelector(selector) === element; } catch { return false; }
        };
        const selectorPart = (element) => {
          const tag = element.tagName.toLowerCase();
          if (element.id) return tag + '#' + cssEscape(element.id);
          for (const attr of ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name', 'title']) {
            const value = element.getAttribute(attr);
            if (value) return tag + '[' + attr + '="' + attrEscape(truncate(value, 120)) + '"]';
          }
          let part = tag + Array.from(element.classList || []).filter((name) => /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(name)).slice(0, 2).map((name) => '.' + cssEscape(name)).join('');
          const parent = element.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')';
          }
          return part;
        };
        const selectorFor = (element) => {
          if (element.id) {
            const idSelector = '#' + cssEscape(element.id);
            if (matches(idSelector, element)) return idSelector;
          }
          const parts = [];
          let current = element;
          while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
            parts.unshift(selectorPart(current));
            const selector = parts.join(' > ');
            if (matches(selector, element)) return selector;
            if (current === document.documentElement) break;
            current = current.parentElement;
          }
          return parts.join(' > ');
        };
        const targetElement = (event) => {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
          const target = path && path.length ? path[0] : event.target;
          if (target instanceof Element) return target;
          return target instanceof Node ? target.parentElement : null;
        };
        const attrs = (element) => {
          const result = {};
          for (const attr of Array.from(element.attributes || []).slice(0, 32)) {
            const name = attr.name.toLowerCase();
            if (name === 'style' || name === 'value' || name.startsWith('on')) continue;
            result[name] = truncate(attr.value || '', 1000);
          }
          return result;
        };
        const payloadFor = (element) => {
          const rect = element.getBoundingClientRect();
          return {
            url: location.href,
            title: document.title || '',
            tagName: element.tagName.toLowerCase(),
            selector: selectorFor(element),
            text: normalize(element.innerText || element.textContent || '', 4000),
            outerHtml: truncate(element.outerHTML || '', 8000),
            attributes: attrs(element),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            href: typeof element.href === 'string' ? element.href : null,
            src: typeof element.src === 'string' ? element.src : null,
            alt: element.getAttribute('alt'),
            role: element.getAttribute('role'),
          };
        };
        const box = document.createElement('div');
        box.dataset.cellsElementPicker = 'true';
        box.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;box-sizing:border-box;border:2px solid rgb(125,211,252);border-radius:6px;background:rgba(14,165,233,.12);box-shadow:0 0 0 1px rgba(2,132,199,.45),0 12px 36px rgba(8,47,73,.22);z-index:2147483647;display:none';
        const label = document.createElement('div');
        label.dataset.cellsElementPicker = 'true';
        label.textContent = 'Click an element to send it to chat. Esc cancels.';
        label.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);pointer-events:none;box-sizing:border-box;max-width:min(520px,calc(100vw - 24px));border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(15,23,42,.92);color:white;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:7px 10px;box-shadow:0 10px 32px rgba(0,0,0,.26);z-index:2147483647';
        (document.body || document.documentElement).appendChild(box);
        (document.body || document.documentElement).appendChild(label);
        const absorb = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        };
        const update = (element) => {
          if (!element || element.closest('[data-cells-element-picker="true"]')) return;
          state.hovered = element;
          const rect = element.getBoundingClientRect();
          box.style.display = 'block';
          box.style.transform = 'translate(' + Math.max(0, Math.round(rect.left)) + 'px,' + Math.max(0, Math.round(rect.top)) + 'px)';
          box.style.width = Math.max(0, Math.round(rect.width)) + 'px';
          box.style.height = Math.max(0, Math.round(rect.height)) + 'px';
        };
        const cleanup = (notifyCancel) => {
          document.removeEventListener('pointermove', onMove, true);
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('contextmenu', onContext, true);
          document.removeEventListener('keydown', onKey, true);
          window.removeEventListener('scroll', onViewport, true);
          window.removeEventListener('resize', onViewport, true);
          box.remove();
          label.remove();
          document.documentElement.style.cursor = state.previousCursor || '';
          document.documentElement.style.userSelect = state.previousUserSelect || '';
          delete window.__cellsNwElementPickerCancel;
          if (notifyCancel) console.log(cancelledMarker + JSON.stringify({ targetAgentWindowId }));
        };
        function onMove(event) { update(targetElement(event)); }
        function onDown(event) { update(targetElement(event)); absorb(event); }
        function onClick(event) {
          const element = targetElement(event) || state.hovered;
          absorb(event);
          cleanup(false);
          if (element) console.log(selectedMarker + JSON.stringify({ targetAgentWindowId, selection: payloadFor(element) }));
          else console.log(cancelledMarker + JSON.stringify({ targetAgentWindowId }));
        }
        function onKey(event) { if (event.key === 'Escape') { absorb(event); cleanup(true); } }
        function onContext(event) { absorb(event); cleanup(true); }
        function onViewport() { if (state.hovered) update(state.hovered); }
        window.__cellsNwElementPickerCancel = cleanup;
        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('contextmenu', onContext, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onViewport, true);
        window.addEventListener('resize', onViewport, true);
        document.documentElement.style.cursor = 'crosshair';
        document.documentElement.style.userSelect = 'none';
        update(document.elementFromPoint(Math.max(0, window.innerWidth / 2), Math.max(0, window.innerHeight / 2)));
        return true;
      })()
    `
}
