// DEBUG panel for tuning Pepito's flight circle (see ../pepitoDebug.ts). Only
// renders while PEPITO_DEBUG is true.

import ReactEcs, { Label, UiEntity } from '@dcl/sdk/react-ecs'
import { clientState } from '../state'
import { orbitCenterNow, orbitTune } from '../pepitoChase'
import { PEPITO_DEBUG, adjustOrbit, debugStartChase, pepitoDebug, printOrbit, resetOrbit, type TuneKey } from '../pepitoDebug'
import { C, S, TactileButton } from './theme'

const ROWS: { key: TuneKey; label: string; step: number }[] = [
  { key: 'offsetX', label: 'Centre X', step: 0.5 },
  { key: 'offsetZ', label: 'Centre Z', step: 0.5 },
  { key: 'height', label: 'Height', step: 0.5 },
  { key: 'radius', label: 'Radius', step: 0.5 },
  { key: 'period', label: 'Lap (s)', step: 1 }
]

export function PepitoDebugPanel() {
  if (!PEPITO_DEBUG) return <UiEntity />
  const c = orbitCenterNow()
  const panelW = S(370)
  const rowH = S(46)
  const pad = S(12)
  const panelH = pad * 2 + S(30) + S(26) + rowH * ROWS.length + S(56) * 2
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: S(130), right: S(16) }, width: panelW, height: panelH, flexDirection: 'column', padding: pad, borderRadius: S(16), pointerFilter: 'block' }}
      uiBackground={{ color: C.panelBg }}
    >
      <Label value="PEPITO FLIGHT (debug)" fontSize={S(20)} color={C.gold} textAlign="middle-left" uiTransform={{ width: '100%', height: S(30) }} />
      <Label
        value={`centre world  x ${c.x.toFixed(1)}   z ${c.z.toFixed(1)}`}
        fontSize={S(15)}
        color={C.dim}
        textAlign="middle-left"
        uiTransform={{ width: '100%', height: S(26) }}
      />
      {ROWS.map((row) => (
        <UiEntity key={row.key} uiTransform={{ width: '100%', height: rowH, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Label value={row.label} fontSize={S(18)} color={C.text} textAlign="middle-left" uiTransform={{ width: S(120), height: rowH }} />
          <TactileButton id={`pd_${row.key}_minus`} label="-" onClick={() => adjustOrbit(row.key, -row.step)} width={S(52)} height={S(40)} fontSize={S(24)} />
          <Label value={`${orbitTune[row.key]}`} fontSize={S(18)} color={C.gold} textAlign="middle-center" uiTransform={{ width: S(70), height: rowH }} />
          <TactileButton id={`pd_${row.key}_plus`} label="+" onClick={() => adjustOrbit(row.key, row.step)} width={S(52)} height={S(40)} fontSize={S(24)} />
        </UiEntity>
      ))}
      <UiEntity uiTransform={{ width: '100%', height: S(56), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <TactileButton
          id="pd_path"
          label={pepitoDebug.showPath ? 'Path: ON' : 'Path: OFF'}
          onClick={() => (pepitoDebug.showPath = !pepitoDebug.showPath)}
          width={S(110)}
          height={S(44)}
          fontSize={S(16)}
        />
        <TactileButton id="pd_print" label="Print" onClick={() => printOrbit()} width={S(110)} height={S(44)} fontSize={S(16)} bg={C.blue} />
        <TactileButton id="pd_reset" label="Reset" onClick={() => resetOrbit()} width={S(110)} height={S(44)} fontSize={S(16)} bg={C.pink} />
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', height: S(56), alignItems: 'center', justifyContent: 'center' }}>
        {!clientState.pepitoChase.active && (
          <TactileButton id="pd_start" label="Start chase (force sick)" onClick={() => debugStartChase()} width={S(330)} height={S(44)} fontSize={S(17)} bg={C.greenDark} />
        )}
      </UiEntity>
    </UiEntity>
  )
}
