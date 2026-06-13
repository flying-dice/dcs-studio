<script lang="ts">
  interface Props {
    side: "left" | "right" | "bottom";
    currentSize: number;
    onresize: (size: number) => void;
  }

  const MIN: Record<Props["side"], number> = { left: 180, right: 180, bottom: 120 };
  const MAX: Record<Props["side"], number> = { left: 520, right: 520, bottom: 600 };

  let { side, currentSize, onresize }: Props = $props();

  const horizontal = $derived(side === "bottom");

  let handleEl = $state<HTMLDivElement | null>(null);
  let hovering  = $state(false);
  let dragging  = $state(false);
  let cursorPos = $state(0); // X for horizontal, Y for vertical

  function onpointermove_handle(e: PointerEvent) {
    if (!handleEl) return;
    const rect = handleEl.getBoundingClientRect();
    cursorPos = horizontal ? e.clientX - rect.left : e.clientY - rect.top;
  }

  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;

    const startPos   = horizontal ? e.clientY : e.clientX;
    const startSize  = currentSize;

    document.body.style.cursor     = horizontal ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";

    function onmove(ev: PointerEvent) {
      const raw = side === "right"  ? startSize - (ev.clientX - startPos)
                  : side === "bottom" ? startSize + (startPos - ev.clientY)
                  : startSize + (ev.clientX - startPos);
      onresize(Math.min(MAX[side], Math.max(MIN[side], raw)));
    }

    function onup() {
      dragging = false;
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onmove);
      window.removeEventListener("pointerup",   onup);
    }

    window.addEventListener("pointermove", onmove);
    window.addEventListener("pointerup",   onup);
  }
</script>

<div
  bind:this={handleEl}
  class="panel-handle {horizontal ? 'horizontal' : 'vertical'}"
  role="separator"
  aria-orientation={horizontal ? "horizontal" : "vertical"}
  onpointerenter={() => (hovering = true)}
  onpointerleave={() => { if (!dragging) hovering = false; }}
  onpointermove={onpointermove_handle}
  onpointerdown={onpointerdown}
>
  {#if hovering || dragging}
    {#if horizontal}
      <div class="indicator h-indicator" style="left: {cursorPos - 200}px"></div>
    {:else}
      <div class="indicator v-indicator" style="top: {cursorPos - 200}px"></div>
    {/if}
  {/if}
</div>

<style>
  .panel-handle {
    position: relative;
    flex-shrink: 0;
    overflow: hidden;
    z-index: 10;
  }

  .vertical {
    width: 8px;
    cursor: col-resize;
  }

  .horizontal {
    height: 8px;
    width: 100%;
    cursor: row-resize;
  }

  .indicator {
    position: absolute;
    pointer-events: none;
  }

  .v-indicator {
    left: 50%;
    transform: translateX(-50%);
    width: 1.5px;
    height: 400px;
    background: linear-gradient(
      to bottom,
      transparent 0%,
      var(--primary) 30%,
      var(--primary) 70%,
      transparent 100%
    );
    animation: fade-in 120ms ease-out;
  }

  .h-indicator {
    top: 50%;
    transform: translateY(-50%);
    height: 1.5px;
    width: 400px;
    background: linear-gradient(
      to right,
      transparent 0%,
      var(--primary) 30%,
      var(--primary) 70%,
      transparent 100%
    );
    animation: fade-in 120ms ease-out;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
</style>
