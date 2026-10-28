export class PropertyResidentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export class PropertyResidentValidationError extends PropertyResidentError {
  constructor(message: string) {
    super(message, 'PROPERTY_RESIDENT_VALIDATION_ERROR', 400);
  }
}

export class PropertyResidentNotFoundError extends PropertyResidentError {
  constructor(message: string) {
    super(message, 'PROPERTY_RESIDENT_NOT_FOUND', 404);
  }
}
