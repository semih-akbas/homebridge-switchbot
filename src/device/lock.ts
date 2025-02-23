/* Copyright(C) 2021-2024, donavanbecker (https://github.com/donavanbecker). All rights reserved.
 *
 * lock.ts: @switchbot/homebridge-switchbot.
 */
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'
import type { bodyChange, device, lockProServiceData, lockProStatus, lockProWebhookContext, lockServiceData, lockStatus, lockWebhookContext, SwitchbotDevice, WoSmartLock } from 'node-switchbot'

import type { SwitchBotPlatform } from '../platform.js'
import type { devicesConfig, lockConfig } from '../settings.js'

/*
* For Testing Locally:
* import { SwitchBotBLEModel, SwitchBotBLEModelName } from '/Users/Shared/GitHub/OpenWonderLabs/node-switchbot/dist/index.js';
*/
import { SwitchBotBLEModel, SwitchBotBLEModelName } from 'node-switchbot'
import { debounceTime, interval, skipWhile, Subject, take, tap } from 'rxjs'

import { formatDeviceIdAsMac } from '../utils.js'
import { deviceBase } from './device.js'

export class Lock extends deviceBase {
  // Services
  private LockMechanism: {
    Name: CharacteristicValue
    Service: Service
    LockTargetState: CharacteristicValue
    LockCurrentState: CharacteristicValue
  }

  private Battery: {
    Name: CharacteristicValue
    Service: Service
    BatteryLevel: CharacteristicValue
    StatusLowBattery: CharacteristicValue
  }

  private ContactSensor?: {
    Name: CharacteristicValue
    Service: Service
    ContactSensorState: CharacteristicValue
  }

  private Switch?: {
    Name: CharacteristicValue
    Service: Service
    On: CharacteristicValue
  }

  // OpenAPI
  deviceStatus!: lockStatus | lockProStatus

  // Webhook
  webhookContext!: lockWebhookContext | lockProWebhookContext

  // BLE
  serviceData!: lockServiceData | lockProServiceData

  // Updates
  lockUpdateInProgress!: boolean
  doLockUpdate!: Subject<void>

  constructor(
    readonly platform: SwitchBotPlatform,
    accessory: PlatformAccessory,
    device: device & devicesConfig,
  ) {
    super(platform, accessory, device)
    // Set category
    accessory.category = this.hap.Categories.DOOR_LOCK

    // this is subject we use to track when we need to POST changes to the SwitchBot API
    this.doLockUpdate = new Subject()
    this.lockUpdateInProgress = false

    // Initialize LockMechanism Service
    accessory.context.LockMechanism = accessory.context.LockMechanism ?? {}
    this.LockMechanism = {
      Name: accessory.displayName,
      Service: accessory.getService(this.hap.Service.LockMechanism) ?? accessory.addService(this.hap.Service.LockMechanism) as Service,
      LockTargetState: accessory.context.LockTargetState ?? this.hap.Characteristic.LockTargetState.SECURED,
      LockCurrentState: accessory.context.LockCurrentState ?? this.hap.Characteristic.LockCurrentState.SECURED,
    }
    accessory.context.LockMechanism = this.LockMechanism as object

    // Initialize LockMechanism Characteristics
    this.LockMechanism.Service.setCharacteristic(this.hap.Characteristic.Name, this.LockMechanism.Name).getCharacteristic(this.hap.Characteristic.LockTargetState).onGet(() => {
      return this.LockMechanism.LockTargetState
    }).onSet(this.LockTargetStateSet.bind(this))

    // Initialize Battery property
    accessory.context.Battery = accessory.context.Battery ?? {}
    this.Battery = {
      Name: `${accessory.displayName} Battery`,
      Service: accessory.getService(this.hap.Service.Battery) ?? accessory.addService(this.hap.Service.Battery) as Service,
      BatteryLevel: accessory.context.BatteryLevel ?? 100,
      StatusLowBattery: accessory.context.StatusLowBattery ?? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    }
    accessory.context.Battery = this.Battery as object

    // Initialize Battery Characteristics
    this.Battery.Service.setCharacteristic(this.hap.Characteristic.Name, this.Battery.Name).setCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE).getCharacteristic(this.hap.Characteristic.BatteryLevel).onGet(() => {
      return this.Battery.BatteryLevel
    })

    this.Battery.Service.getCharacteristic(this.hap.Characteristic.StatusLowBattery).onGet(() => {
      return this.Battery.StatusLowBattery
    })

    // Contact Sensor Service
    if ((device as lockConfig).hide_contactsensor) {
      if (this.ContactSensor) {
        this.debugLog('Removing Contact Sensor Service')
        this.ContactSensor.Service = this.accessory.getService(this.hap.Service.ContactSensor) as Service
        accessory.removeService(this.ContactSensor.Service)
      }
    } else {
      accessory.context.ContactSensor = accessory.context.ContactSensor ?? {}
      this.ContactSensor = {
        Name: `${accessory.displayName} Contact Sensor`,
        Service: accessory.getService(this.hap.Service.ContactSensor) ?? this.accessory.addService(this.hap.Service.ContactSensor) as Service,
        ContactSensorState: accessory.context.ContactSensorState ?? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
      }
      accessory.context.ContactSensor = this.ContactSensor as object

      // Initialize Contact Sensor Characteristics
      this.ContactSensor.Service.setCharacteristic(this.hap.Characteristic.Name, this.ContactSensor.Name).setCharacteristic(this.hap.Characteristic.StatusActive, true).getCharacteristic(this.hap.Characteristic.ContactSensorState).onGet(() => {
        return this.ContactSensor!.ContactSensorState
      })
    }

    // Initialize Latch Button Service
    if ((device as lockConfig).activate_latchbutton === false) {
      if (this.Switch) {
        this.debugLog('Removing Latch Button Service')
        this.Switch.Service = accessory.getService(this.hap.Service.Switch) as Service
        accessory.removeService(this.Switch.Service)
      }
    } else {
      accessory.context.Switch = accessory.context.Switch ?? {}
      this.Switch = {
        Name: `${accessory.displayName} Latch`,
        Service: accessory.getService(this.hap.Service.Switch) ?? accessory.addService(this.hap.Service.Switch) as Service,
        On: accessory.context.On ?? false,
      }
      accessory.context.Switch = this.Switch as object

      // Initialize Latch Button Characteristics
      this.Switch.Service.setCharacteristic(this.hap.Characteristic.Name, this.Switch.Name).getCharacteristic(this.hap.Characteristic.On).onGet(() => {
        return this.Switch!.On
      }).onSet(this.OnSet.bind(this))
    }

    // Retrieve initial values and updateHomekit
    try {
      this.debugLog('Retrieve initial values and update Homekit')
      this.refreshStatus()
    } catch (e: any) {
      this.errorLog(`failed to retrieve initial values and update Homekit, Error: ${e.message ?? e}`)
    }

    // regisiter webhook event handler if enabled
    try {
      this.debugLog('Registering Webhook Event Handler')
      this.registerWebhook()
    } catch (e: any) {
      this.errorLog(`failed to registerWebhook, Error: ${e.message ?? e}`)
    }

    // regisiter platform BLE event handler if enabled
    try {
      this.debugLog('Registering Platform BLE Event Handler')
      this.registerPlatformBLE()
    } catch (e: any) {
      this.errorLog(`failed to registerPlatformBLE, Error: ${e.message ?? e}`)
    }

    // Start an update interval
    interval(this.deviceRefreshRate * 1000)
      .pipe(skipWhile(() => this.lockUpdateInProgress))
      .subscribe(async () => {
        await this.refreshStatus()
      })

    // Watch for Lock change events
    // We put in a debounce of 100ms so we don't make duplicate calls
    this.doLockUpdate
      .pipe(
        tap(() => {
          this.lockUpdateInProgress = true
        }),
        debounceTime(this.devicePushRate * 1000),
      )
      .subscribe(async () => {
        try {
          await this.pushChanges()
        } catch (e: any) {
          await this.apiError(e)
          this.errorLog(`failed pushChanges with ${device.connectionType} Connection, Error Message: ${JSON.stringify(e.message)}`)
        }
        this.lockUpdateInProgress = false
      })
  }

  async BLEparseStatus(): Promise<void> {
    this.debugLog('BLEparseStatus')
    this.debugLog(`(lockState) = BLE:(${this.serviceData.status}), current:(${this.LockMechanism.LockCurrentState})`)

    // LockCurrentState
    this.LockMechanism.LockCurrentState = this.serviceData.status === 'locked'
      ? this.hap.Characteristic.LockCurrentState.SECURED
      : this.hap.Characteristic.LockCurrentState.UNSECURED
    this.debugLog(`LockCurrentState: ${this.LockMechanism.LockCurrentState}`)

    // LockTargetState
    this.LockMechanism.LockTargetState = this.serviceData.status === 'locked'
      ? this.hap.Characteristic.LockTargetState.SECURED
      : this.hap.Characteristic.LockTargetState.UNSECURED
    this.debugLog(`LockTargetState: ${this.LockMechanism.LockTargetState}`)

    // Contact Sensor
    if (!(this.device as lockConfig).hide_contactsensor && this.ContactSensor?.Service) {
      this.ContactSensor.ContactSensorState = this.serviceData.door_open
        ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
      this.debugLog(`ContactSensorState: ${this.ContactSensor.ContactSensorState}`)
    }
    // Battery Info
    if ('battery' in this.serviceData) {
      // BatteryLevel
      this.Battery.BatteryLevel = this.serviceData.battery
      this.debugLog(`BatteryLevel: ${this.Battery.BatteryLevel}`)
      // StatusLowBattery
      this.Battery.StatusLowBattery = this.Battery.BatteryLevel < 10
        ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      this.debugLog(`StatusLowBattery: ${this.Battery.StatusLowBattery}`)
    }
  }

  async openAPIparseStatus(): Promise<void> {
    this.debugLog('openAPIparseStatus')
    this.debugLog(`(lockState) = OpenAPI:(${this.deviceStatus.lockState}), current:(${this.LockMechanism.LockCurrentState})`)

    // LockCurrentState
    this.LockMechanism.LockCurrentState = this.deviceStatus.lockState === 'locked'
      ? this.hap.Characteristic.LockCurrentState.SECURED
      : this.hap.Characteristic.LockCurrentState.UNSECURED
    this.debugLog(`LockCurrentState: ${this.LockMechanism.LockCurrentState}`)

    // LockTargetState
    this.LockMechanism.LockTargetState = this.deviceStatus.lockState === 'locked'
      ? this.hap.Characteristic.LockTargetState.SECURED
      : this.hap.Characteristic.LockTargetState.UNSECURED
    this.debugLog(`LockTargetState: ${this.LockMechanism.LockTargetState}`)

    // ContactSensorState
    if (!(this.device as lockConfig).hide_contactsensor && this.ContactSensor?.Service) {
      this.ContactSensor.ContactSensorState = this.deviceStatus.doorState === 'opened'
        ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
      this.debugLog(`ContactSensorState: ${this.ContactSensor.ContactSensorState}`)
    }

    // BatteryLevel
    this.Battery.BatteryLevel = this.deviceStatus.battery
    this.debugLog(`BatteryLevel: ${this.Battery.BatteryLevel}`)

    // StatusLowBattery
    this.Battery.StatusLowBattery = this.Battery.BatteryLevel < 10
      ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
    this.debugLog(`StatusLowBattery: ${this.Battery.StatusLowBattery}`)

    // Firmware Version
    if (this.deviceStatus.version) {
      const version = this.deviceStatus.version.toString()
      this.debugLog(`Firmware Version: ${version.replace(/^V|-.*$/g, '')}`)
      const deviceVersion = version.replace(/^V|-.*$/g, '') ?? '0.0.0'
      this.accessory
        .getService(this.hap.Service.AccessoryInformation)!
        .setCharacteristic(this.hap.Characteristic.HardwareRevision, deviceVersion)
        .setCharacteristic(this.hap.Characteristic.FirmwareRevision, deviceVersion)
        .getCharacteristic(this.hap.Characteristic.FirmwareRevision)
        .updateValue(deviceVersion)
      this.accessory.context.version = deviceVersion
      this.debugSuccessLog(`version: ${this.accessory.context.version}`)
    }
  }

  async parseStatusWebhook(): Promise<void> {
    this.debugLog('parseStatusWebhook')
    this.debugLog(`(lockState) = Webhook:(${this.webhookContext.lockState}), current:(${this.LockMechanism.LockCurrentState})`)

    // LockCurrentState
    this.LockMechanism.LockCurrentState = this.webhookContext.lockState === 'LOCKED'
      ? this.hap.Characteristic.LockCurrentState.SECURED
      : this.hap.Characteristic.LockCurrentState.UNSECURED
    this.debugLog(`LockCurrentState: ${this.LockMechanism.LockCurrentState}`)

    // LockTargetState
    this.LockMechanism.LockTargetState = this.webhookContext.lockState === 'LOCKED'
      ? this.hap.Characteristic.LockTargetState.SECURED
      : this.hap.Characteristic.LockTargetState.UNSECURED
    this.debugLog(`LockTargetState: ${this.LockMechanism.LockTargetState}`)
  }

  /**
   * Asks the SwitchBot API for the latest device information
   */
  async refreshStatus(): Promise<void> {
    if (!this.device.enableCloudService && this.OpenAPI) {
      this.errorLog(`refreshStatus enableCloudService: ${this.device.enableCloudService}`)
    } else if (this.BLE) {
      await this.BLERefreshStatus()
    } else if (this.OpenAPI && this.platform.config.credentials?.token) {
      await this.openAPIRefreshStatus()
    } else {
      await this.offlineOff()
      this.debugWarnLog(`Connection Type: ${this.device.connectionType}, refreshStatus will not happen.`)
    }
  }

  async BLERefreshStatus(): Promise<void> {
    this.debugLog('BLERefreshStatus')
    const switchBotBLE = await this.switchbotBLE()
    if (switchBotBLE === undefined) {
      await this.BLERefreshConnection(switchBotBLE)
    } else {
      // Start to monitor advertisement packets
      (async () => {
        // Start to monitor advertisement packets
        const serviceData = await this.monitorAdvertisementPackets(switchBotBLE) as lockServiceData | lockProServiceData
        // Update HomeKit
        if ((serviceData.model === SwitchBotBLEModel.Lock || SwitchBotBLEModel.LockPro)
          && (serviceData.modelName === SwitchBotBLEModelName.Lock || SwitchBotBLEModelName.LockPro)) {
          this.serviceData = serviceData
          await this.BLEparseStatus()
          await this.updateHomeKitCharacteristics()
        } else {
          this.errorLog(`failed to get serviceData, serviceData: ${JSON.stringify(serviceData)}`)
          await this.BLERefreshConnection(switchBotBLE)
        }
      })()
    }
  }

  async registerPlatformBLE(): Promise<void> {
    this.debugLog('registerPlatformBLE')
    if (this.config.options?.BLE) {
      this.debugLog('is listening to Platform BLE.')
      try {
        const formattedDeviceId = formatDeviceIdAsMac(this.device.deviceId)
        this.device.bleMac = formattedDeviceId
        this.debugLog(`bleMac: ${this.device.bleMac}`)
        this.platform.bleEventHandler[this.device.bleMac] = async (context: lockServiceData | lockProServiceData) => {
          try {
            this.debugLog(`received BLE: ${JSON.stringify(context)}`)
            this.serviceData = context
            await this.BLEparseStatus()
            await this.updateHomeKitCharacteristics()
          } catch (e: any) {
            this.errorLog(`failed to handle BLE. Received: ${JSON.stringify(context)} Error: ${e.message ?? e}`)
          }
        }
      } catch (error) {
        this.errorLog(`failed to format device ID as MAC, Error: ${error}`)
      }
    } else {
      this.debugLog('is not listening to Platform BLE')
    }
  }

  async openAPIRefreshStatus(): Promise<void> {
    this.debugLog('openAPIRefreshStatus')
    try {
      const response = await this.deviceRefreshStatus()
      const deviceStatus: any = response.body
      this.debugLog(`statusCode: ${deviceStatus.statusCode}, deviceStatus: ${JSON.stringify(deviceStatus)}`)
      if (await this.successfulStatusCodes(deviceStatus)) {
        this.debugSuccessLog(`statusCode: ${deviceStatus.statusCode}, deviceStatus: ${JSON.stringify(deviceStatus)}`)
        this.deviceStatus = deviceStatus.body
        await this.openAPIparseStatus()
        await this.updateHomeKitCharacteristics()
      } else {
        this.debugWarnLog(`statusCode: ${deviceStatus.statusCode}, deviceStatus: ${JSON.stringify(deviceStatus)}`)
        this.debugWarnLog(deviceStatus)
      }
    } catch (e: any) {
      await this.apiError(e)
      this.errorLog(`failed openAPIRefreshStatus with ${this.device.connectionType} Connection, Error Message: ${JSON.stringify(e.message)}`)
    }
  }

  async registerWebhook() {
    if (this.device.webhook) {
      this.debugLog('is listening webhook.')
      this.platform.webhookEventHandler[this.device.deviceId] = async (context: lockWebhookContext | lockProWebhookContext) => {
        try {
          this.debugLog(`received Webhook: ${JSON.stringify(context)}`)
          this.webhookContext = context
          await this.parseStatusWebhook()
          await this.updateHomeKitCharacteristics()
        } catch (e: any) {
          this.errorLog(`failed to handle webhook. Received: ${JSON.stringify(context)} Error: ${e.message ?? e}`)
        }
      }
    } else {
      this.debugLog('is not listening webhook.')
    }
  }

  /**
   * Pushes the requested changes to the SwitchBot API
   * deviceType  commandType   Command    command parameter   Description
   * Lock   -    "command"     "lock"     "default"  =        set to ???? state
   * Lock   -    "command"     "unlock"   "default"  =        set to ???? state - LockCurrentState
   */
  async pushChanges(): Promise<void> {
    if (!this.device.enableCloudService && this.OpenAPI) {
      this.errorLog(`pushChanges enableCloudService: ${this.device.enableCloudService}`)
    } else if (this.BLE) {
      await this.BLEpushChanges()
    } else if (this.OpenAPI && this.platform.config.credentials?.token) {
      await this.openAPIpushChanges()
    } else {
      await this.offlineOff()
      this.debugWarnLog(`Connection Type: ${this.device.connectionType}, pushChanges will not happen.`)
    }
    // Refresh the status from the API
    interval(15000)
      .pipe(skipWhile(() => this.lockUpdateInProgress))
      .pipe(take(1))
      .subscribe(async () => {
        await this.refreshStatus()
      })
  }

  async BLEpushChanges(): Promise<void> {
    this.debugLog('BLEpushChanges')
    if (this.LockMechanism.LockTargetState !== this.accessory.context.LockTargetState) {
      const switchBotBLE = await this.platform.connectBLE(this.accessory, this.device)
      try {
        const formattedDeviceId = formatDeviceIdAsMac(this.device.deviceId)
        this.device.bleMac = formattedDeviceId
        this.debugLog(`bleMac: ${this.device.bleMac}`)
        if (switchBotBLE !== false) {
          switchBotBLE
            .discover({ model: this.device.bleModel, id: this.device.bleMac })
            .then(async (device_list: SwitchbotDevice[]) => {
              return await this.retryBLE({
                max: this.maxRetryBLE(),
                fn: async () => {
                  if (this.LockMechanism.LockTargetState === this.hap.Characteristic.LockTargetState.SECURED) {
                    return await (device_list[0] as WoSmartLock).lock()
                  } else {
                    return await (device_list[0] as WoSmartLock).unlock()
                  }
                },
              })
            })
            .then(async () => {
              this.successLog(`LockTargetState: ${this.LockMechanism.LockTargetState} sent over SwitchBot BLE, sent successfully`)
              await this.updateHomeKitCharacteristics()
            })
            .catch(async (e: any) => {
              await this.apiError(e)
              this.errorLog(`failed BLEpushChanges with ${this.device.connectionType} Connection, Error Message: ${JSON.stringify(e.message)}`)
              await this.BLEPushConnection()
            })
        } else {
          this.errorLog(`wasn't able to establish BLE Connection, node-switchbot: ${JSON.stringify(switchBotBLE)}`)
          await this.BLEPushConnection()
        }
      } catch (error) {
        this.errorLog(`failed to format device ID as MAC, Error: ${error}`)
      }
    } else {
      this.debugLog(`No changes (BLEpushChanges), LockTargetState: ${this.LockMechanism.LockTargetState}, LockCurrentState: ${this.LockMechanism.LockCurrentState}`)
    }
  }

  async openAPIpushChanges(LatchUnlock?: boolean): Promise<void> {
    this.debugLog('openAPIpushChanges')
    if ((this.LockMechanism.LockTargetState !== this.accessory.context.LockTargetState) || LatchUnlock) {
      // Determine the command based on the LockTargetState or the forceUnlock parameter
      const command = LatchUnlock ? 'unlock' : this.LockMechanism.LockTargetState ? 'lock' : 'unlock'
      const bodyChange: bodyChange = {
        command: `${command}`,
        parameter: 'default',
        commandType: 'command',
      }
      this.debugLog(`SwitchBot OpenAPI bodyChange: ${JSON.stringify(bodyChange)}`)
      try {
        const response = await this.pushChangeRequest(bodyChange)
        const deviceStatus: any = response.body
        this.debugLog(`statusCode: ${deviceStatus.statusCode}, deviceStatus: ${JSON.stringify(deviceStatus)}`)
        if (await this.successfulStatusCodes(deviceStatus)) {
          this.debugSuccessLog(`statusCode: ${deviceStatus.statusCode}, deviceStatus: ${JSON.stringify(deviceStatus)}`)
          await this.updateHomeKitCharacteristics()
        } else {
          await this.statusCode(deviceStatus.statusCode)
        }
      } catch (e: any) {
        await this.apiError(e)
        this.errorLog(`failed openAPIpushChanges with ${this.device.connectionType} Connection, Error Message: ${JSON.stringify(e.message)}`)
      }
    } else {
      this.debugLog(`No changes (openAPIpushChanges), LockCurrentState: ${this.LockMechanism.LockCurrentState}, TargetPosition: ${this.LockMechanism.LockTargetState}`)
    }
  }

  /**
   * Handle requests to set the value of the "On" characteristic
   */
  async LockTargetStateSet(value: CharacteristicValue): Promise<void> {
    if (this.LockMechanism.LockTargetState !== this.accessory.context.LockTargetState) {
      this.infoLog(`Set LockTargetState: ${value}`)
    } else {
      this.debugLog(`No Changes, LockTargetState: ${value}`)
    }

    this.LockMechanism.LockTargetState = value
    this.doLockUpdate.next()
  }

  /**
   * Handle requests to set the value of the "On" characteristic
   */
  async OnSet(value: CharacteristicValue): Promise<void> {
    this.debugLog(`Latch Button Set On: ${value}`)
    if (value) {
      this.debugLog('Attempting to open the latch')

      this.openAPIpushChanges(value as boolean).then(async () => {
        this.debugLog('Latch opened successfully')
        this.debugLog(`SwitchService is: ${this.Switch?.Service ? 'available' : 'not available'}`)

        // simulate button press to turn the switch back off
        if (this.Switch?.Service) {
          const SwitchService = this.Switch.Service
          // Simulate a button press by waiting a short period before turning the switch off
          setTimeout(async () => {
            SwitchService.getCharacteristic(this.hap.Characteristic.On).updateValue(false)
            this.debugLog('Latch button switched off automatically.')
          }, 500) // 500 ms delay
        }
      }).catch(async (e: any) => {
        // Log the error if the operation failed
        this.debugLog(`Error opening latch: ${e.message ?? e}`)
        // Ensure we turn the switch back off even in case of an error
        if (this.Switch?.Service) {
          this.Switch.Service.getCharacteristic(this.hap.Characteristic.On).updateValue(false)
          this.debugLog('Latch button switched off after an error.')
        }
      })
    } else {
      this.debugLog('Switch is off, nothing to do')
    }

    this.Switch!.On = value
    this.doLockUpdate.next()
  }

  async updateHomeKitCharacteristics(): Promise<void> {
    // LockCurrentState
    await this.updateCharacteristic(this.LockMechanism.Service, this.hap.Characteristic.LockTargetState, this.LockMechanism.LockTargetState, 'LockTargetState')
    // LockCurrentState
    await this.updateCharacteristic(this.LockMechanism.Service, this.hap.Characteristic.LockCurrentState, this.LockMechanism.LockCurrentState, 'LockCurrentState')
    // ContactSensorState
    if (!(this.device as lockConfig).hide_contactsensor && this.ContactSensor?.Service) {
      await this.updateCharacteristic(this.ContactSensor.Service, this.hap.Characteristic.ContactSensorState, this.ContactSensor.ContactSensorState, 'ContactSensorState')
    }
    // BatteryLevel
    await this.updateCharacteristic(this.Battery.Service, this.hap.Characteristic.BatteryLevel, this.Battery.BatteryLevel, 'BatteryLevel')
    // StatusLowBattery
    await this.updateCharacteristic(this.Battery.Service, this.hap.Characteristic.StatusLowBattery, this.Battery.StatusLowBattery, 'StatusLowBattery')
  }

  async BLEPushConnection() {
    if (this.platform.config.credentials?.token && this.device.connectionType === 'BLE/OpenAPI') {
      this.warnLog('Using OpenAPI Connection to Push Changes')
      await this.openAPIpushChanges()
    }
  }

  async BLERefreshConnection(switchbot: any): Promise<void> {
    this.errorLog(`wasn't able to establish BLE Connection, node-switchbot: ${switchbot}`)
    if (this.platform.config.credentials?.token && this.device.connectionType === 'BLE/OpenAPI') {
      this.warnLog('Using OpenAPI Connection to Refresh Status')
      await this.openAPIRefreshStatus()
    }
  }

  async offlineOff(): Promise<void> {
    if (this.device.offline) {
      this.LockMechanism.Service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.SECURED)
      this.LockMechanism.Service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.SECURED)
      if (!(this.device as lockConfig).hide_contactsensor && this.ContactSensor?.Service) {
        this.ContactSensor.Service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED)
      }
    }
  }

  async apiError(e: any): Promise<void> {
    this.LockMechanism.Service.updateCharacteristic(this.hap.Characteristic.LockTargetState, e)
    this.LockMechanism.Service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, e)
    if (!(this.device as lockConfig).hide_contactsensor && this.ContactSensor?.Service) {
      this.ContactSensor.Service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, e)
    }
    this.Battery.Service.updateCharacteristic(this.hap.Characteristic.BatteryLevel, e)
    this.Battery.Service.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, e)
  }
}
