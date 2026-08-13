import { Directive, EventEmitter, HostListener, Output } from '@angular/core';

@Directive({
  selector: '[dragAndDropFiles]',
  standalone: true,
})
export class DragAndDropFilesDirective {
  @Output() fileDropped = new EventEmitter<FileList | undefined>();

  // Dragover listener
  @HostListener('dragover', ['$event']) onDragOver(evt: DragEvent) {
    evt.preventDefault();
    evt.stopPropagation();
  }

  // Dragleave listener
  @HostListener('dragleave', ['$event']) public onDragLeave(evt: DragEvent) {
    evt.preventDefault();
    evt.stopPropagation();
  }

  /**drop listener */
  @HostListener('drop', ['$event']) public onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (event) {
      if (event.dataTransfer) {
        const files = event.dataTransfer.files;
        if (files && files.length > 0) {
          this.fileDropped.emit(files);
        }
        event.dataTransfer.clearData();
      }
    }
  }
}

/**
 * Create FileList
 * @param files
 * @returns FileList
 */
export const makeFileList = (files: File[]) => {
  const reducer = (dataTransfer: DataTransfer, file: File) => {
    dataTransfer.items.add(file);
    return dataTransfer;
  };

  return files.reduce(reducer, new DataTransfer()).files;
};
