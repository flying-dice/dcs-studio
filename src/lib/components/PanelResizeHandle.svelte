<script lang="ts">
  interface Props {
    side: "left" | "right";
    currentWidth: number;
    onresize: (width: number) => void;
  }

  const MIN_W = 180;
  const MAX_W = 520;

  let { side, currentWidth, onresize }: Props = $props();

  let handleEl = $state<HTMLDivElement | null>(null);
  let hovering = $state(false);
  let dragging = $state(false);
  let cursorY  = $state(0);

  function onpointermove_handle(e: PointerEvent) {
    if (!handleEl) return;
    cursorY = e.clientY - handleEl.getBoundingClientRect().top;
  }

  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;

    const startX     = e.clientX;
    const startWidth = currentWidth;

    document.body.style.cursor     = "col-resize";
    document.body.style.userSelect = "none";

    function onmove(ev: PointerEvent) {
      const dx  = ev.clientX - startX;
      const raw = side === "left" ? startWidth + dx : startWidth - dx;
      onresize(Math.min(MAX_W, Math.max(MIN_W, raw)));
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
  class="panel-handle"
  role="separator"
  aria-orientation="vertical"
  onpointerenter={() => (hovering = true)}
  onpointerleave={() => { if (!dragging) hovering = false; }}
  onpointermove={onpointermove_handle}
  onpointerdown={onpointerdown}
>
  {#if hovering || dragging}
    <div class="glow-line" style="top: {cursorY - 200}px"></div>
  {/if}
</div>

<style>
  .panel-handle {
    position: relative;
    width: 8px;
    flex-shrink: 0;
    cursor: col-resize;
    overflow: visible;
    z-index: 10;
  }

  .glow-line {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: 1.5px;
    height: 400px;
    pointer-events: none;
    background: linear-gradient(
      to bottom,
      transparent 0%,
      var(--primary) 30%,
      var(--primary) 70%,
      transparent 100%
    );
    animation: glow-in 120ms ease-out;
  }

  @keyframes glow-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
</style>
