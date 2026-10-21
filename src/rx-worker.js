import { Receiver, modulate } from './modem.js';
import { encodePacket } from './packet.js';
import { noiseChannel } from './channel.js';
let epoch = 0;
const makeReceiver = () => { const current = epoch; return new Receiver(event => postMessage({ ...event, epoch: current })); };
let receiver = makeReceiver();
onmessage = ({ data }) => {
  if (data.type === 'reset') { epoch = data.epoch ?? epoch + 1; receiver = makeReceiver(); }
  if (data.type === 'samples' && data.epoch === epoch) receiver.push(data.samples);
  if (data.type === 'selftest') {
    const events = [];
    const rx = new Receiver(e => events.push(e));
    rx.push(noiseChannel(modulate(encodePacket(data.text), { offset: 80, delay: 0.173125 }), { snr: 10, seed: 2026 }));
    const received = events.find(e => e.type === 'packet');
    postMessage({ type: 'test-result', ok: received?.packet.text === data.text, offset: received?.offset });
  }
};
