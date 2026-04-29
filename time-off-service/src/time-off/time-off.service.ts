import { Injectable, InternalServerErrorException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Balance } from './entities/balance.entity';
import { TimeOffRequest, RequestStatus } from './entities/time-off-request.entity';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';

@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    @InjectRepository(Balance)
    private balancesRepository: Repository<Balance>,
    @InjectRepository(TimeOffRequest)
    private requestsRepository: Repository<TimeOffRequest>,
    private dataSource: DataSource,
  ) {}

  private get hcmUrl(): string {
    return process.env.HCM_URL || 'http://localhost:4000/hcm';
  }

  async createRequest(dto: CreateTimeOffRequestDto): Promise<TimeOffRequest> {
    if (dto.idempotencyKey) {
      const existing = await this.requestsRepository.findOneBy({ idempotencyKey: dto.idempotencyKey });
      if (existing) {
        return existing;
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    let newRequest: TimeOffRequest;

    try {
      const balance = await queryRunner.manager.findOne(Balance, {
        where: { employeeId: dto.employeeId, locationId: dto.locationId },
      });

      if (!balance) {
        throw new BadRequestException('Balance not found for employee');
      }

      const actualAvailable = balance.totalDays - balance.reservedDays;

      if (actualAvailable < dto.daysRequested) {
        throw new BadRequestException('Insufficient balance (including reserved days)');
      }

      balance.reservedDays = Number(balance.reservedDays) + Number(dto.daysRequested);
      await queryRunner.manager.save(balance);

      newRequest = queryRunner.manager.create(TimeOffRequest, {
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        daysRequested: dto.daysRequested,
        status: RequestStatus.PENDING,
        idempotencyKey: dto.idempotencyKey || null,
      });
      await queryRunner.manager.save(newRequest);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.syncRequest(newRequest.id, dto.locationId, dto.daysRequested).catch(err => {
      this.logger.error(`[Sync] Deferred sync failed for Request ID ${newRequest.id}: ${err.message}`);
    });

    return newRequest;
  }

  async syncRequest(requestId: string, locationId: string, daysRequested: number, attempts = 3) {
    const request = await this.requestsRepository.findOneBy({ id: requestId });
    if (!request || request.status !== RequestStatus.PENDING) return;

    for (let count = 1; count <= attempts; count++) {
      try {
        const response = await fetch(`${this.hcmUrl}/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            employeeId: request.employeeId,
            locationId: locationId,
            daysRequested: daysRequested,
          }),
        });

        const data = await response.json().catch(() => null);

        let finalState = false;

        await this.dataSource.transaction(async manager => {
          const balance = await manager.findOne(Balance, {
              where: { employeeId: request.employeeId, locationId: locationId }
          });
          
          if (data && data.status === 'APPROVED') {
            request.status = RequestStatus.APPROVED;
            request.hcmReferenceId = data.hcmReferenceId;
            if (balance) {
                balance.totalDays -= daysRequested;
                balance.reservedDays -= daysRequested;
                await manager.save(balance);
            }
            this.logger.log(`[Sync] Request ID ${requestId} -> Approved`);
            finalState = true;
          } else if (data && data.status === 'REJECTED') {
            request.status = RequestStatus.REJECTED;
            if (balance) {
                balance.reservedDays -= daysRequested;
                await manager.save(balance);
            }
            this.logger.log(`[Sync] Request ID ${requestId} -> Rejected (${data.reason})`);
            finalState = true;
          } else if (!response.ok) {
             throw new Error(`HTTP Error ${response.status}`);
          }
          await manager.save(request);
        });

        if (finalState) return;

      } catch (error: any) {
        if (count === attempts) {
          this.logger.error(`[Sync] Max retries reached for Request ID ${requestId}`);
        } else {
          await new Promise(res => setTimeout(res, 1000 * count));
        }
      }
    }
  }

  async getBalances(employeeId: string, locationId: string) {
      const balance = await this.balancesRepository.findOneBy({employeeId, locationId});
      if(!balance) throw new BadRequestException('Balance not available');
      return {
          total: balance.totalDays,
          reserved: balance.reservedDays,
          actualAvailable: balance.totalDays - balance.reservedDays
      };
  }

  /**
   * Synchronizes external HCM balances into the local database (Reconciliation)
   */
  async reconcileBatch(locationId: string, employeeId?: string) {
    const query: any = {};
    if (locationId) query.locationId = locationId;
    if (employeeId) query.employeeId = employeeId;

    const balances = await this.balancesRepository.find({ where: query });
    
    if (employeeId && locationId && balances.length === 0) {
      balances.push(this.balancesRepository.create({ employeeId, locationId, totalDays: 0, reservedDays: 0 }));
    }

    const report = {
      updated: 0,
      alreadyInSync: 0,
      pendingRetried: 0,
      details: []
    };

    for (const balance of balances) {
      try {
        const response = await fetch(`${this.hcmUrl}/balance?employeeId=${balance.employeeId}&locationId=${balance.locationId}`);
        if (!response.ok) {
          report.details.push({ employeeId: balance.employeeId, status: 'HCM_NOT_FOUND' });
          continue;
        }
        
        const hcmData = await response.json();
        
        if (hcmData.totalDays > balance.totalDays) {
          const oldTotal = balance.totalDays;
          balance.totalDays = hcmData.totalDays;
          await this.balancesRepository.save(balance);
          
          report.updated++;
          report.details.push({ 
            employeeId: balance.employeeId, 
            status: 'UPDATED', 
            oldTotal, 
            newTotal: balance.totalDays 
          });
          this.logger.log(`[Sync] Anniversary detected for Emp ${balance.employeeId} -> Balance Updated`);
        } else {
          report.alreadyInSync++;
          report.details.push({ employeeId: balance.employeeId, status: 'IN_SYNC', currentTotal: balance.totalDays });
        }
      } catch (error: any) {
        this.logger.error(`Reconciliation fetch failed for ${balance.employeeId}: ${error.message}`);
        report.details.push({ employeeId: balance.employeeId, status: 'ERROR', error: error.message });
      }
    }

    const pendingRequests = await this.requestsRepository.find({
      where: { ...query, status: RequestStatus.PENDING }
    });

    for (const req of pendingRequests) {
      this.logger.log(`Batch Sync -> Retrying PENDING request ${req.id} for employee ${req.employeeId}`);
      this.syncRequest(req.id, req.locationId, req.daysRequested, 1).catch(() => {});
      report.pendingRetried++;
    }

    return report;
  }
}
