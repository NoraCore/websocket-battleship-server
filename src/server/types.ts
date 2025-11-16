export type UUID = string;


export type ServerMessage = {
  type: string; // e.g., "reg", "create_game", "start_game", "turn", "attack", "finish", "update_room", "update_winners"
  data?: any;
  id: number;
};