import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'truncate',
  standalone: true,
})
export class TruncatePipe implements PipeTransform {
  /**
   * *Transforms a string by truncating it to a specified limit, adding ellipses at the end.
   *
   * @param {string} value - The input string to be truncated.
   * @param {number} limit - The maximum length of the truncated string.
   * @param {boolean} completeWords - If true, ensures that the truncated string ends with a complete word.
   * @param {boolean} isCollapsed - If true, returns the original string without truncating it.
   * @returns The truncated string with ellipses at the end.
   *
   *
   */
  public transform(
    value: string,
    limit: number,
    completeWords = false,
    isCollapsed?: boolean,
  ): string {
    if (value === null) {
      return '';
    } else {
      if (isCollapsed) {
        return value;
      } else {
        const defaultLimit = 50;
        const ellipses = '...';

        if (typeof value === 'undefined') {
          return '';
        }
        if (value.length <= limit) {
          return value;
        }

        if (completeWords) {
          limit = value.substring(0, limit).lastIndexOf(' ');
        }

        const desiredLimit = limit ? limit : defaultLimit;

        // .. truncate to about correct length
        const truncatedText = value.substring(0, desiredLimit);

        return truncatedText + ellipses;
      }
    }
  }
}
