import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'initialName',
  standalone: true,
})
export class InitialNamePipe implements PipeTransform {
  transform(fullName: string | undefined): string {
    if (!fullName) return '';
    const names = fullName.split(' ');
    let initials = names[0].charAt(0);
    if (names.length > 1) {
      initials += names[names.length - 1].charAt(0);
    }
    return initials.toUpperCase();
  }
}
