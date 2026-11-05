export class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}
