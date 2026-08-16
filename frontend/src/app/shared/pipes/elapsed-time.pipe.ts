import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'elapsedTime',
  standalone: true,
})
export class ElapsedTimePipe implements PipeTransform {
  transform(ms?: number | null): string {
    if (!ms || ms < 0) return '';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min <= 0) return `${sec}s`;
    return `${min}m ${sec.toString().padStart(2, '0')}s`;
  }
}
