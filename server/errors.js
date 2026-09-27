export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class DeviceError extends Error {
  constructor(message, { status, code, cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.code = code;
  }
}
