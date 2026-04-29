import { Entity, Column, PrimaryGeneratedColumn, VersionColumn, UpdateDateColumn } from 'typeorm';

@Entity('balances')
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  employeeId: string;

  @Column({ type: 'varchar', length: 100 })
  locationId: string;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  totalDays: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  reservedDays: number;

  @VersionColumn()
  version: number;

  @UpdateDateColumn()
  updatedAt: Date;
}
