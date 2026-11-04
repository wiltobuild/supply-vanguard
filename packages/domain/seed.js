export const roomIds=['room-101','room-102','room-103','room-104','room-105','room-106','clean-supply','staff-base','equipment-store','family-lounge'];
export function seedEquipment(){return [
 ['EQ-001','Transport incubator','incubator','equipment-store','available'],
 ['EQ-002','Infusion pump 01','infusion','room-101','in-use'],
 ['EQ-003','Infusion pump 02','infusion','equipment-store','available'],
 ['EQ-004','Portable monitor 01','monitor','room-102','in-use'],
 ['EQ-005','Portable monitor 02','monitor','equipment-store','maintenance'],
 ['EQ-006','Radiant warmer','warmer','room-103','cleaning'],
 ['EQ-007','Bedside cart 104','supply-cart','room-104','available'],
 ['EQ-008','Bedside cart 106','supply-cart','room-106','available']
 ].map(([id,name,modelKind,roomId,status])=>({id,name,modelKind,roomId,status,version:0,lastSeenAt:null,source:'synthetic-seed'}));}
