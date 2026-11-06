import { Button, Field, NumberInput, Select, TextInput } from "../../components/design-system";
import type { AdvancedRuntimeEdit } from "./application-runtime-fields";

export function AdvancedRuntimeControls({
  value, onChange, working,
}: {
  value: AdvancedRuntimeEdit;
  onChange: (value: AdvancedRuntimeEdit) => void;
  working: boolean;
}) {
  const set = (change: Partial<AdvancedRuntimeEdit>) => onChange({ ...value, ...change });
  return <>
    <div className="md:col-span-2 border-t border-[#E1E7F0] pt-4">
      <h4 className="text-sm font-semibold">Container command arguments</h4>
      <p className="mt-1 text-xs text-[#5B6678]">Arguments are passed as a list, not a shell command. Empty list uses the image default. Do not include credentials.</p>
    </div>
    <div className="md:col-span-2 space-y-2">
      {value.command.map((arg, i) => <div key={i} className="flex gap-2">
        <TextInput aria-label={`Command argument ${i + 1}`} value={arg}
          onChange={e => set({ command: value.command.map((v, j) => j === i ? e.target.value : v) })} />
        <Button size="sm" variant="ghost" disabled={working} onClick={() => set({ command: value.command.filter((_, j) => j !== i) })}>Remove argument {i + 1}</Button>
      </div>)}
      <Button size="sm" disabled={working} onClick={() => set({ command: [...value.command, ""] })}>Add argument</Button>
    </div>
    <label className="md:col-span-2 flex items-start gap-2 rounded-lg border border-[#D7E0EC] p-3 text-sm">
      <input type="checkbox" checked={value.readOnlyRootFilesystem}
        onChange={e => set({ readOnlyRootFilesystem: e.target.checked })} />
      <span><strong>Read-only root filesystem</strong><span className="block text-xs text-[#5B6678]">Writes require mounted volumes or tmpfs. Enabled only after the App Group is deployed.</span></span>
    </label>
    <div className="md:col-span-2 border-t border-[#E1E7F0] pt-4">
      <h4 className="text-sm font-semibold">Container health check</h4>
      <label className="mt-2 inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.healthEnabled} onChange={e => set({ healthEnabled: e.target.checked })} />Enable health check
      </label>
    </div>
    {value.healthEnabled ? <>
      <div className="md:col-span-2"><Field label="Health check shell command" required hint="Executed by Docker as CMD-SHELL. Use only commands trusted for this image.">
        <TextInput aria-label="Health check shell command" value={value.healthCommand} onChange={e => set({ healthCommand: e.target.value })} />
      </Field></div>
      <Field label="Health interval (seconds)"><NumberInput min={1} max={86400} step={1} value={value.healthInterval} onChange={e => set({ healthInterval: Number(e.target.value) })}/></Field>
      <Field label="Health timeout (seconds)"><NumberInput min={1} max={86400} step={1} value={value.healthTimeout} onChange={e => set({ healthTimeout: Number(e.target.value) })}/></Field>
      <Field label="Health retries"><NumberInput min={1} max={100} step={1} value={value.healthRetries} onChange={e => set({ healthRetries: Number(e.target.value) })}/></Field>
      <Field label="Health start period (seconds)"><NumberInput min={0} max={86400} step={1} value={value.healthStartPeriod} onChange={e => set({ healthStartPeriod: Number(e.target.value) })}/></Field>
    </> : <p className="md:col-span-2 text-xs text-[#5B6678]">Disabled health checks are removed from the next deployed draft.</p>}
    <div className="md:col-span-2 border-t border-[#E1E7F0] pt-4"><h4 className="text-sm font-semibold">Restart policy</h4></div>
    <Field label="Restart condition"><Select value={value.restartCondition} onChange={e => set({ restartCondition: e.target.value })}>
      <option value="any">Always</option><option value="on-failure">On failure</option><option value="none">Never</option>
    </Select></Field>
    <Field label="Restart delay (seconds)"><NumberInput min={0} max={86400} step={1} value={value.restartDelay} onChange={e => set({ restartDelay: Number(e.target.value) })}/></Field>
    <Field label="Max restart attempts" hint="Optional; blank preserves unlimited/default behavior"><TextInput inputMode="numeric" value={value.restartMaxAttempts} onChange={e => set({ restartMaxAttempts: e.target.value })}/></Field>
    <Field label="Restart window (seconds)" hint="Optional"><TextInput inputMode="numeric" value={value.restartWindow} onChange={e => set({ restartWindow: e.target.value })}/></Field>
    <div className="md:col-span-2 border-t border-[#E1E7F0] pt-4"><h4 className="text-sm font-semibold">Deployment update policy</h4><p className="mt-1 text-xs text-[#5B6678]">Docker Swarm pauses the rollout on a failure; failure action is not editable here.</p></div>
    <Field label="Update parallelism"><NumberInput min={0} max={1000} step={1} value={value.updateParallelism} onChange={e => set({ updateParallelism: Number(e.target.value) })}/></Field>
    <Field label="Update delay (seconds)"><NumberInput min={0} max={86400} step={1} value={value.updateDelay} onChange={e => set({ updateDelay: Number(e.target.value) })}/></Field>
    <Field label="Update order"><Select value={value.updateOrder} onChange={e => set({ updateOrder: e.target.value })}>
      <option value="start-first">Start new task first</option><option value="stop-first">Stop old task first</option>
    </Select></Field>
  </>;
}
