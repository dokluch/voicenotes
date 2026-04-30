"use client";

interface MicPickerProps {
  devices: MediaDeviceInfo[];
  selectedId: string;
  onChange: (id: string) => void;
}

export function MicPicker({ devices, selectedId, onChange }: MicPickerProps) {
  if (devices.length === 0) return null;
  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor="mic-select" className="text-neutral-500 dark:text-neutral-400 shrink-0">
        Microphone
      </label>
      <select
        id="mic-select"
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
        className="bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700
                   text-neutral-900 dark:text-neutral-100
                   rounded-md px-2 py-1 text-sm
                   focus:outline-none focus:ring-2 focus:ring-neutral-400 min-w-0 flex-1
                   truncate cursor-pointer"
      >
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
    </div>
  );
}
