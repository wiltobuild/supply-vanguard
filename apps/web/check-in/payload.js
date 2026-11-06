// Labels contain only an equipment ID, optionally prefixed SV1:. Never interpret URLs or markup.
export function parseEquipmentLabel(value) {
 if (typeof value !== 'string' || value.length > 68) throw new Error('Enter an equipment ID of at most 64 characters.');
 const id=value.trim().replace(/^SV1:/,'');
 if (id.length>64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('Use the equipment ID printed on the label, for example EQ-001.');
 return id;
}
