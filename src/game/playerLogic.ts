import {createPlayer, findPlayerByLogin} from "../models/models.js";

export const register = (login:string, password:string) => {
  if (findPlayerByLogin(login)) throw new Error("Login exists");
  return createPlayer(login,password);
};

export const login = (login:string, password:string) => {
  const p = findPlayerByLogin(login);
  if (!p) throw new Error("No such user");
  if (p.password !== password) throw new Error("Invalid password");
  return p;
};