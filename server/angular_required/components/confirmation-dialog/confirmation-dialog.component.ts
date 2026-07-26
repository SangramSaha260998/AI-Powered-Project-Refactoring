import {
  Inject,
  OnInit,
  Output,
  Component,
  EventEmitter,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';

interface IDialogData {
  photoIcon?: string;
  dialogType?: 'normal' | 'warning';
  title?: string;
  heading?: string;
  message?: string;
  buttonText?: { ok?: string; cancel?: string };
  showButton?: { ok?: boolean; cancel?: boolean };
  cancelButtonShow: boolean;
  sameButtonColor: boolean;
}

@Component({
  selector: 'confirmation-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './confirmation-dialog.component.html',
  styleUrl: './confirmation-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmationDialogComponent implements OnInit {
  message = '';
  photoIcon = '';
  title = 'Warning';
  heading = '';
  showCancelButton = true;
  cancelButtonText = 'No';
  showConfirmButton = true;
  confirmButtonText = 'Save';
  cancelButtonShow = false;
  sameButtonColor = false;
  dialogType: 'normal' | 'warning' = 'warning';
  @Output() confirmDialog: EventEmitter<boolean> = new EventEmitter<boolean>();
  @Output() cancelDialog: EventEmitter<boolean> = new EventEmitter<boolean>();

  constructor(
    @Inject(MAT_DIALOG_DATA) private data: IDialogData,
    private dialogRef: MatDialogRef<ConfirmationDialogComponent>,
  ) {}

  ngOnInit(): void {
    if (this.data) {
      this.dialogType = this.data.dialogType || this.dialogType;
      this.photoIcon = this.data.photoIcon || this.photoIcon;
      this.title = this.data.title || this.title;
      this.heading = this.data.heading || this.heading;
      this.message = this.data.message || this.message;
      this.sameButtonColor = this.data.sameButtonColor || this.sameButtonColor;
      if (this.data.buttonText) {
        this.confirmButtonText = this.data.buttonText.ok || this.confirmButtonText;
        this.cancelButtonText = this.data.buttonText.cancel || this.cancelButtonText;
      }
      if (this.data.showButton) {
        this.showConfirmButton = this.data.showButton.ok ?? this.showConfirmButton;
        this.showCancelButton = this.data.showButton.cancel ?? this.showCancelButton;
      }
      this.cancelButtonShow = this.data.cancelButtonShow || this.cancelButtonShow;
    }
  }

  /*
   * *Mat Dialog Delete Method
   */
  onConfirmDialogFn() {
    this.dialogRef.close(true);
    this.confirmDialog.emit(true);
  }

  /*
   * *Mat Dialog Close Method
   */
  onCancelDialogFn(): void {
    this.dialogRef.close(false);
    this.cancelDialog.emit(true);
  }

  closeDialog() {
    this.dialogRef.close();
  }
}
