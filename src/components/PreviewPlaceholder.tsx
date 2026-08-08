// Static placeholder shown while Three.js loads asynchronously.
// No Three.js dependency — this is ~300 bytes.

export default function PreviewPlaceholder() {
  return (
    <div className="w-full h-full min-h-[400px] lg:min-h-[600px] rounded-tool overflow-hidden relative">
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-900">
        <svg className="w-12 h-12 text-surface-600 mb-3" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        </svg>
        <p className="text-sm text-surface-400">Upload an image to preview</p>
      </div>
    </div>
  );
}
