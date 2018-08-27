const dataJSON = require('./data.json');

function getScheduleOfElectricalDevices (data) {
  let parseData;
  try {
    parseData = JSON.parse(data);
  } catch (e) {
    parseData = data;
  }

  const {devices, rates, maxPower} = parseData;

  const dayMode = {from: 7, to: 21, duration: 14};
  const nightMode = {from: 21, to: 7, duration: 10};

  function sortByDuration (a, b) {
    return b.duration - a.duration;
  }

  const sortedDevicesForScheduling = devices.reduce((acc, item, index, arr) => {
    if (!acc[24]) acc[24] = [];
    if (!acc.rest) acc.rest = [];
    if (!acc.dayMode) acc.dayMode = [];
    if (!acc.nightMode) acc.nightMode = [];
    if (!acc.withoutMode) acc.withoutMode = [];

    if (item.duration === 24) acc[24].push(item);
    else {
      if (item.mode === 'night') acc.nightMode.push(item);
      else if (item.mode === 'day') acc.dayMode.push(item);
      else acc.withoutMode.push(item);
    }

    if (arr.length === index + 1) {
      acc.nightMode.sort(sortByDuration);
      acc.dayMode.sort(sortByDuration);
      acc.withoutMode.sort(sortByDuration);
      acc.rest = dayMode.duration > nightMode.duration
        ? [...acc.nightMode, ...acc.dayMode, ...acc.withoutMode]
        : [...acc.dayMode, ...acc.nightMode, ...acc.withoutMode];
    }

    return acc;
  }, {});

  function initScheduleItem (from, to, acc, item) {
    for (let i = from; i < to; i++) {
      acc[i] = {};
      acc[i].hour = i;
      acc[i].rate = item.value;
      acc[i].leftPower = maxPower;
      acc[i].schedule = [];
    }
  }

  const allPossibleSchedules = [[]];

  allPossibleSchedules[0][0] = rates.reduce((acc, item) => {
    if (item.to < item.from) {
      initScheduleItem(item.from, 24, acc, item);
      initScheduleItem(0, item.to, acc, item);
    } else {
      initScheduleItem(item.from, item.to, acc, item);
    }
    acc.push({totalConsumedEnergy: 0, devices: {}});
    return acc;
  }, []);

  function getScheduleWithAddedDevice (schedule, start, duration, device, cost) {
    let startHour = start;
    let interval = duration;
    const newSchedule = schedule
      .map(item => Object.assign({}, item))
      .map((item) => {
        const newItem = item;
        if (newItem.schedule) newItem.schedule = [...newItem.schedule];
        if (newItem.devices) newItem.devices = Object.assign({}, newItem.devices);
        return newItem;
      });

    while (interval) {
      newSchedule[startHour].schedule.push(device.id);
      newSchedule[startHour].leftPower -= device.power;
      interval--;
      startHour++;
      if (startHour === 24) startHour = 0;
    }

    const consumedEnergy = newSchedule[newSchedule.length - 1];
    consumedEnergy.devices[device.id] = cost;
    consumedEnergy.totalConsumedEnergy =
      Math.round((consumedEnergy.totalConsumedEnergy + cost) * 10000) / 10000;

    return newSchedule;
  }

  function add24HoursDevicesInSchedules () {
    const totalPowerPerHour24HoursDevices = sortedDevicesForScheduling[24].reduce((acc, item) => {
      if (item.power) return acc + item.power;
      return acc;
    }, 0);

    if (totalPowerPerHour24HoursDevices > maxPower) {
      throw Error('The schedule can not be built. Your 24hours devices consume energy per hour more then acceptable.');
    }

    const ratesSum = allPossibleSchedules[0][0].reduce((acc, item) => {
      if (item.rate) return acc + item.rate;
      return acc;
    }, 0);

    sortedDevicesForScheduling[24].forEach((device) => {
      const cost = Math.round((ratesSum * (device.power / 1000)) * 10000) / 10000;
      allPossibleSchedules[0][0] = getScheduleWithAddedDevice(allPossibleSchedules[0][0], 0, 24, device, cost);
    });
  }

  function getPossibleHoursForDeviceWithCost (device, schedule) {
    const copyOfSchedule = schedule.map(item => Object.assign({}, item));

    let possibleHours = copyOfSchedule.filter((item) => {
      if (item.totalConsumedEnergy) return false;
      if (device.mode === 'day') {
        return device.power <= item.leftPower &&
          (item.hour >= dayMode.from && item.hour < dayMode.to);
      }
      if (device.mode === 'night') {
        return device.power <= item.leftPower &&
          (item.hour >= nightMode.from || item.hour < nightMode.to);
      }
      return device.power <= item.leftPower;
    });

    const helperForFindingDuration = possibleHours.reduce((acc, item) => {
      acc[item.hour] = true;
      return acc;
    }, {});

    possibleHours = possibleHours
      .map((item) => {
        let checkHour = item.hour;
        const newHour = item;
        newHour.availableDuration = 0;

        while (helperForFindingDuration[checkHour]) {
          newHour.availableDuration++;
          checkHour++;
          if (checkHour === 24) checkHour = 0;
          if (checkHour === item.hour) break;
        }

        return newHour;
      })
      .filter(item => item.availableDuration >= device.duration)
      .map((item) => {
        let cost = 0;
        let checkHour = item.hour;
        let {duration} = device;
        const newHour = item;

        while (duration) {
          cost += (device.power / 1000) *
            schedule[checkHour].rate;
          duration--;
          checkHour++;
          if (checkHour === 24) checkHour = 0;
        }

        newHour.cost = Math.round(cost * 10000) / 10000;
        return newHour;
      });

    return possibleHours;
  }

  function addRestOfDevicesInSchedules () {
    if (!sortedDevicesForScheduling.rest.length) return;

    for (let level = 0; level < sortedDevicesForScheduling.rest.length; level++) {
      const device = sortedDevicesForScheduling.rest[level];

      allPossibleSchedules[level].forEach((schedule) => {
        const possibleHours = getPossibleHoursForDeviceWithCost(device, schedule);

        if (possibleHours) {
          possibleHours.forEach((item) => {
            if (!allPossibleSchedules[level + 1]) allPossibleSchedules[level + 1] = [];
            const newSchedule = getScheduleWithAddedDevice(schedule, item.hour, device.duration, device, item.cost);
            allPossibleSchedules[level + 1].push(newSchedule);
          });
        }
      });

      if (!allPossibleSchedules[level + 1]) {
        throw Error('The schedule can not be built. Your devices consume energy per hour more then acceptable.');
      }
    }
  }

  function getFinalSchedule () {
    add24HoursDevicesInSchedules();
    addRestOfDevicesInSchedules();

    const finalSchedule = {schedule: {}, consumedEnergy: {}};
    const minCostSchedule = allPossibleSchedules[allPossibleSchedules.length - 1].sort((a, b) =>
      a[a.length - 1].totalConsumedEnergy - b[b.length - 1].totalConsumedEnergy)[0];

    minCostSchedule.forEach((item) => {
      if (!item.totalConsumedEnergy) {
        finalSchedule.schedule[item.hour] = [...item.schedule];
      } else {
        finalSchedule.consumedEnergy.value = item.totalConsumedEnergy;
        finalSchedule.consumedEnergy.devices = Object.assign({}, item.devices);
      }
    });

    return finalSchedule;
  }

  return JSON.stringify(getFinalSchedule());
}

const schedule = getScheduleOfElectricalDevices(dataJSON);
console.log(schedule);
