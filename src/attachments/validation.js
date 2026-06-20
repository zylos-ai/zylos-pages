const ARTIFACT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEY_RE = /^[a-zA-Z0-9._-]{1,100}$/;
const ATTACHMENT_ID_RE = /^[a-f0-9]{32}$/;
const ARTIFACT_ID_MAX_LENGTH = 100;

export function validateArtifactId(artifact) {
  return typeof artifact === 'string'
    && artifact.length <= ARTIFACT_ID_MAX_LENGTH
    && ARTIFACT_ID_RE.test(artifact);
}

export function validateItemKey(key) {
  return typeof key === 'string' && KEY_RE.test(key);
}

export function validateAttachmentId(attachmentId) {
  return typeof attachmentId === 'string' && ATTACHMENT_ID_RE.test(attachmentId);
}

export function assertValidArtifactId(artifact) {
  if (!validateArtifactId(artifact)) {
    throw Object.assign(new Error('Invalid artifact ID'), { statusCode: 400 });
  }
}

export function assertValidItemKey(key) {
  if (!validateItemKey(key)) {
    throw Object.assign(new Error('Invalid key'), { statusCode: 400 });
  }
}

export function assertValidAttachmentId(attachmentId) {
  if (!validateAttachmentId(attachmentId)) {
    throw Object.assign(new Error('Invalid attachment ID'), { statusCode: 400 });
  }
}
