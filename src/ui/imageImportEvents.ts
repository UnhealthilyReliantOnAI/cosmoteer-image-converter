/** Leave native paste intact in text fields, including nested editable elements. */
export function isTextEditing(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}

export function clipboardImage(items: Iterable<DataTransferItem>): File | null {
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

const supportedMime = new Set(['image/png', 'image/jpeg', 'image/webp']);

const supportedName = /\.(png|jpe?g|webp)$/i;

export function hasFileDrag(data: DataTransfer | null): boolean {
  return !!data && (Array.from(data.types).includes('Files') || Array.from(data.items).some((item) => item.kind === 'file'));
}
/** Only a visual hint during drag; the existing content decoder remains authoritative on drop. */
export function compatibleDrag(data: DataTransfer): boolean {
  if (data.files.length) return Array.from(data.files).some((file) => supportedMime.has(file.type) || supportedName.test(file.name) || !file.type);
  const items = Array.from(data.items).filter((item) => item.kind === 'file');
  // Some native drags expose only the Files type until release; defer content checks to drop.
  return items.length === 0 ? hasFileDrag(data) : items.some((item) => !item.type || supportedMime.has(item.type));
}

export interface DropState {
  readonly visible: boolean;
  readonly cancelling: boolean;
}

/** One window-wide listener set, shared by the import zone and the rest of the page. */
export function installWindowImageDrop(target: Window, onFile: (file: File) => void, onState: (state: DropState) => void) {
  let depth = 0;
  let suppressed = false;
  let visible = false;
  let cancelling = false;
  const cancellationRegion = (event: DragEvent) => event.target instanceof Element
    && !!event.target.closest('[data-cancel-image-drop]');
  const publish = (shown: boolean, overCancellation = false) => {
    if (visible === shown && cancelling === overCancellation) return;
    visible = shown;
    cancelling = overCancellation;
    onState({ visible: shown, cancelling });
  };
  const reset = () => {
    depth = 0;
    suppressed = false;
    publish(false);
  };
  const cancel = () => {
    suppressed = true;
    publish(false);
  };
  const enter = (event: DragEvent) => {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    depth++;
    if (!suppressed && compatibleDrag(event.dataTransfer!)) publish(true, cancellationRegion(event));
  };
  const over = (event: DragEvent) => {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = suppressed ? 'none' : 'copy';
    if (!suppressed && compatibleDrag(event.dataTransfer!)) publish(true, cancellationRegion(event));
  };
  const leave = () => {
    if (depth > 0) depth--;
    if (depth === 0) reset();
  };
  const drop = (event: DragEvent) => {
    if (!hasFileDrag(event.dataTransfer) && !visible && !suppressed) return;
    event.preventDefault();
    const cancelled = suppressed || cancellationRegion(event);
    const files = Array.from(event.dataTransfer?.files ?? []);
    reset();
    // Hints choose a likely image first, but never replace content validation by the decoder.
    const file = files.find((candidate) => supportedMime.has(candidate.type) || supportedName.test(candidate.name)) ?? files[0];
    if (!cancelled && file) onFile(file);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && visible) {
      event.preventDefault();
      cancel();
    }
  };
  target.addEventListener('dragenter', enter);
  target.addEventListener('dragover', over);
  target.addEventListener('dragleave', leave);
  target.addEventListener('drop', drop);
  target.addEventListener('dragend', reset);
  target.addEventListener('blur', reset);
  target.addEventListener('keydown', key);
  return {
    cancel,
    dispose: () => {
      target.removeEventListener('dragenter', enter);
      target.removeEventListener('dragover', over);
      target.removeEventListener('dragleave', leave);
      target.removeEventListener('drop', drop);
      target.removeEventListener('dragend', reset);
      target.removeEventListener('blur', reset);
      target.removeEventListener('keydown', key);
    },
  };
}
