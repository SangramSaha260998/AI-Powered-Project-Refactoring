import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  standalone: true,
  name: 'svgSprite',
})
export class GenerateSvgSpritePipe implements PipeTransform {
  spriteBasePath = '/scss/icons.svg';
  transform(id: string): string {
    return `${this.spriteBasePath}#${id}`;
  }
}
