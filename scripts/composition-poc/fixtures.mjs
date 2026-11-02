const level = 100 / 127;
const note = (pitch, start, duration, velocity = level) => ({ pitch, start, duration, velocity });
const repeat = (events, count, length = 4) => Array.from({ length: count }, (_, i) => events.map(e => ({ ...e, start: e.start + i * length }))).flat();
const quarters = [60, 62, 64, 65].map((pitch, i) => note(pitch, i, 1));
export const fixtures = [
  { id: 'quarter', category: 'quarter', length: 4, scribble: { notes: 'C4 D4 E4 F4', pattern: 'xxxx', subdiv: '4n' }, strudel: 'c4 d4 e4 f4', expected: quarters },
  { id: 'eighth', category: 'eighth', length: 4, scribble: { notes: 'C4 D4 E4 F4 G4 A4 B4 C5', pattern: 'xxxxxxxx', subdiv: '8n' }, strudel: 'c4 d4 e4 f4 g4 a4 b4 c5', expected: [60,62,64,65,67,69,71,72].map((p,i)=>note(p,i/2,1/2)) },
  { id: 'rests', category: 'rest', length: 4, scribble: { notes: 'C4 E4', pattern: 'x-x-', subdiv: '4n' }, strudel: 'c4 ~ e4 ~', expected: [note(60,0,1),note(64,2,1)] },
  { id: 'tie-rest', category: 'tie', length: 4, scribble: { notes: 'C4 D4 E4', pattern: 'x__-xx--', subdiv: '8n' }, strudel: 'c4@3 ~ d4 e4 ~ ~', expected: [note(60,0,1.5),note(62,2,.5),note(64,2.5,.5)] },
  { id: 'chords', category: 'chord', length: 4, scribble: { notes: [['C4','E4','G4'],['D4','F4','A4']], pattern: 'x_x_', subdiv: '4n' }, strudel: '[c4,e4,g4] [d4,f4,a4]', expected: [60,64,67].map(p=>note(p,0,2)).concat([62,65,69].map(p=>note(p,2,2))) },
  { id: 'nested-binary', category: 'nested pattern', length: 4, scribble: { notes: 'C4 D4 E4 F4 G4 A4 B4', pattern: 'x[xx][x[xx]]x', subdiv: '4n' }, strudel: 'c4 [d4 e4] [f4 [g4 a4]] b4', expected: [note(60,0,1),note(62,1,.5),note(64,1.5,.5),note(65,2,.5),note(67,2.5,.25),note(69,2.75,.25),note(71,3,1)] },
  { id: 'triplet', category: 'triplet', length: 4, scribble: { notes: 'C4 D4 E4 F4 G4 A4', pattern: '[xxx]xxx', subdiv: '4n' }, strudel: '[c4 d4 e4] f4 g4 a4', expected: [note(60,0,1/3),note(62,1/3,1/3),note(64,2/3,1/3),note(65,1,1),note(67,2,1),note(69,3,1)] },
  { id: 'nested-triplet', category: 'nested triplet', length: 4, scribble: { notes: 'C4 D4 E4 F4 G4 A4 B4', pattern: 'x[x[xxx]]xx', subdiv: '4n' }, strudel: 'c4 [d4 [e4 f4 g4]] a4 b4', expected: [note(60,0,1),note(62,1,.5),note(64,1.5,1/6),note(65,5/3,1/6),note(67,11/6,1/6),note(69,2,1),note(71,3,1)] },
  ...[8,16,32].map(bars=>({ id: `quarter-${bars}-bars`, category: 'long arrangement', length: bars*4, repeats: bars, scribble: { notes: 'C4 D4 E4 F4', pattern: 'xxxx', subdiv: '4n' }, strudel: 'c4 d4 e4 f4', expected: repeat(quarters,bars) })),
  { id: 'finite-window', category: 'finite window', length: 4, window: [1,3.25], scribble: { notes: 'C4 D4', pattern: 'x_____x-', subdiv: '8n' }, strudel: 'c4@6 d4 ~', expected: [note(60,1,2),note(62,3,.25)] },
  { id: 'cross-bar-tie', category: 'cross-bar tie', length: 8, scribble: { notes: 'C4', pattern: 'x_______', subdiv: '4n' }, strudel: 'c4/2', expected: [note(60,0,8)] },
  { id: 'cross-bar-window', category: 'cross-bar window', length: 8, window: [1,6], scribble: { notes: 'C4', pattern: 'x_______', subdiv: '4n' }, strudel: 'c4/2', expected: [note(60,1,5)] },
  { id: 'native-one-measure', category: 'native bar unit', length: 4, scribble: { notes: 'C4', pattern: 'x', subdiv: '1m' }, strudel: 'c4', expected: [note(60,0,4)] },
  ...[0,1,64,127].map(velocity=>({ id: `velocity-${velocity}`, category: 'velocity', length: 4, amp: velocity, scribble: { notes: 'C4', pattern: 'x___', subdiv: '4n' }, strudel: 'c4', expected: [note(60,0,4,velocity/127)] })),
];
