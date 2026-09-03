import { isWithinUploadLimit, isZipFileName } from './file.utils';

describe('upload file helpers', () => {
  it('accepts .zip in any case', () => {
    expect(isZipFileName('app.zip')).toBeTrue();
    expect(isZipFileName('app.ZIP')).toBeTrue();
    expect(isZipFileName('app.Zip')).toBeTrue();
  });

  it('rejects non-zip names', () => {
    expect(isZipFileName('app.tar')).toBeFalse();
    expect(isZipFileName('app.zip.txt')).toBeFalse();
  });

  it('enforces the 50 MB upload cap', () => {
    const max = 50 * 1024 * 1024;
    expect(isWithinUploadLimit(max, max)).toBeTrue();
    expect(isWithinUploadLimit(max + 1, max)).toBeFalse();
  });
});
