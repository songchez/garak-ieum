import { MAX_CHANNEL_NAME, MAX_ENABLED_INPUTS, type NativeDeviceProfile } from '../core/audioSettings'
import { driverChannelName, inputChoices, toggleInput, toggleStereoPair } from '../audio/native/deviceProfile'

type Channel = { index: number; name: string }
type Change = (change: (profile: NativeDeviceProfile) => NativeDeviceProfile) => void

interface Props {
  inputs: Channel[]
  outputs: Channel[]
  inputProfile: NativeDeviceProfile
  outputProfile: NativeDeviceProfile
  disabled: boolean
  /** Why the lists are empty or approximate (probing, no device, probe failed). */
  note?: string | null
  onInputs: Change
  onOutputs: Change
}

/** Ableton-style Input/Output Config: enable inputs, pair them, and name channels per device. */
export function NativeChannelConfig({ inputs, outputs, inputProfile, outputProfile, disabled, note, onInputs, onOutputs }: Props) {
  const driverInputs: string[] = [], driverOutputs: string[] = []
  for (const channel of inputs) driverInputs[channel.index] = channel.name
  for (const channel of outputs) driverOutputs[channel.index] = channel.name
  const count = inputs.length ? Math.max(...inputs.map(channel => channel.index)) + 1 : 0
  const exists = (channel: number) => channel < count
  const full = inputProfile.inputs.length >= MAX_ENABLED_INPUTS
  const choices = inputChoices(inputProfile, driverInputs, count || undefined)
  const pairs = Array.from({ length: Math.ceil(count / 2) }, (_, pair) => pair * 2)
  // Enabled channels the current device does not have (a profile from another interface) stay visible to switch off.
  const missing = inputProfile.inputs.filter(channel => !exists(channel))
  const nameInput = (kind: 'input' | 'output', channel: number, profile: NativeDeviceProfile, driver: string[], change: Change) => {
    const key = kind === 'input' ? 'inputNames' : 'outputNames'
    const label = driverChannelName(driver[channel], channel, kind)
    return <input type="text" aria-label={`${kind === 'input' ? '입력' : '출력'} ${channel + 1} 이름`} placeholder={label} maxLength={MAX_CHANNEL_NAME} value={profile[key][channel] ?? ''} disabled={disabled}
      onChange={event => { const value = event.target.value; change(current => { const names = { ...current[key] }; if (value) names[channel] = value; else delete names[channel]; return { ...current, [key]: names } }) }}/>
  }

  return <>
    <h3>입력 채널</h3>
    <p className="audio-settings-note">켠 채널만 드라이버에서 엽니다(최대 {MAX_ENABLED_INPUTS}개). 스테레오 쌍을 켜면 트랙 입력에서 두 채널을 함께 고를 수 있습니다. 이름을 비워 두면 드라이버의 채널 이름을 씁니다.</p>
    {note && <p className="audio-settings-note" role="status">{note}</p>}
    {count > 0 && <div className="audio-channel-grid" role="group" aria-label="입력 채널">
      {pairs.map(left => <div className="audio-channel-pair" key={left}>
        {[left, left + 1].filter(exists).map(channel => {
          const enabled = inputProfile.inputs.includes(channel)
          return <div className="audio-channel-row" key={channel}>
            <label><input type="checkbox" checked={enabled} disabled={disabled || (!enabled && full)} onChange={event => onInputs(profile => toggleInput(profile, channel, event.target.checked))}/><span>{channel + 1}</span></label>
            {nameInput('input', channel, inputProfile, driverInputs, onInputs)}
          </div>
        })}
        {exists(left + 1) && <label className="audio-channel-stereo"><input type="checkbox" checked={inputProfile.stereoPairs.includes(left)} disabled={disabled || (!inputProfile.stereoPairs.includes(left) && inputProfile.inputs.filter(channel => channel !== left && channel !== left + 1).length + 2 > MAX_ENABLED_INPUTS)}
          onChange={event => onInputs(profile => toggleStereoPair(profile, left, event.target.checked))}/><span>스테레오 {left + 1}/{left + 2}</span></label>}
      </div>)}
    </div>}
    {missing.length > 0 && <p className="audio-settings-note">이 장치에 없는 입력 {missing.map(channel => channel + 1).join(', ')}번이 켜져 있습니다. <button type="button" className="audio-small-button" disabled={disabled} onClick={() => onInputs(profile => missing.reduce((next, channel) => toggleInput(next, channel, false), profile))}>없는 채널 끄기</button></p>}
    {full && <p className="audio-settings-note">입력은 최대 {MAX_ENABLED_INPUTS}개까지 켤 수 있습니다.</p>}
    <p className="audio-settings-note audio-channel-choices">트랙에서 고를 수 있는 입력 · {choices.length ? choices.map(choice => choice.label).join(', ') : '없음 · 녹음하려면 입력을 하나 이상 켜 주세요.'}</p>
    {outputs.length > 0 && <>
      <h3>출력 채널 이름</h3>
      <div className="audio-channel-grid" role="group" aria-label="출력 채널 이름">
        {outputs.map(channel => <div className="audio-channel-row" key={channel.index}><span className="audio-channel-number">{channel.index + 1}</span>{nameInput('output', channel.index, outputProfile, driverOutputs, onOutputs)}</div>)}
      </div>
    </>}
  </>
}
